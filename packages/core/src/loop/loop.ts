import type { PlanStep, RunEventData } from "../events.js";
import type { Message } from "../messages.js";
import { validateConversation } from "../messages.js";
import {
  type GenerateResult,
  generateAndCollect,
  type Provider,
  ProviderError,
  type ToolChoice,
  type ToolSpec,
  type Usage,
} from "../provider.js";
import type { InvokeOptions, ToolInvocation } from "../registry.js";
import type { Executor, ToolContext } from "../tool.js";
import { COMPACTION_THRESHOLD, chooseCutIndex, renderTranscript } from "./context.js";
import {
  CONTROL_TOOL_NAMES,
  controlToolSpecs,
  describePlan,
  escalateInputSchema,
  finishInputSchema,
  formatReasons,
  planInputSchema,
  renderArgIssues,
  validateFinish,
  validatePlan,
  verdictToolSpec,
} from "./control-tools.js";
import {
  buildSystemPrompt,
  COMPACTION_SYSTEM,
  EMPTY_RESPONSE_NUDGE,
  isReminderBlock,
  REVIEWER_SYSTEM,
  renderStateReminder,
  repetitionNudge,
  stoppedWithOpenStepsNudge,
  TRUNCATED_NUDGE,
} from "./prompts.js";
import {
  buildReviewDigest,
  buildReviewMessage,
  DEFAULT_MAX_REJECTIONS,
  type ModelPricing,
  parseVerdict,
  type ReviewerConfig,
} from "./reviewer.js";
import {
  applyEvent,
  canonicalJson,
  estimateTokens,
  type PendingResponse,
  type RunState,
  rebuildState,
} from "./state.js";
import {
  type FailureOrigin,
  type InboxItem,
  LeaseLostError,
  type RunRecord,
  type RunResult,
  type RunStatus,
  type RunStore,
  type StoredEvent,
} from "./store.js";

export type { ModelPricing, ReviewerConfig } from "./reviewer.js";

export interface BotConfig {
  id: string;
  name: string;
  personality: string;
  model: {
    id: string;
    contextWindow: number;
    maxOutputTokens: number;
    pricing?: ModelPricing;
  };
  /** Names of registry tools the bot may use. The control tools are always available. */
  allowedTools: string[];
  limits: { maxTurns: number; maxCostUsd?: number; maxDurationMs?: number };
}

/** The part of `ToolRegistry` the loop needs, so a replay invoker can stand in for it. */
export interface ToolInvoker {
  specs(allowed?: string[]): ToolSpec[];
  invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    opts?: InvokeOptions,
  ): Promise<ToolInvocation>;
}

export interface LoopDeps {
  store: RunStore;
  provider: Provider;
  tools: ToolInvoker;
  executor: Executor;
  bot: BotConfig;
  /** When absent, `finish` is validated by the harness only. */
  reviewer?: ReviewerConfig;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RunLoopOptions {
  /**
   * Hard interruption. Aborting cancels the model call in flight and the tool in flight, and the
   * calls not started yet get an "interrupted" result, so the conversation stays valid. The loop
   * then returns `running`: the run is NOT marked cancelled or failed. What happens next is up to
   * the caller (the worker): put the run back in the queue to resume it, or cancel it.
   */
  signal?: AbortSignal;
  /**
   * Soft stop. Once raised, the loop finishes the turn it is in (the model call and every tool
   * call it asked for, none of them is cancelled) and, at the next safe point, returns `running`
   * WITHOUT starting another model call. A run that finishes or pauses for the user during that
   * last turn settles normally instead. Like `signal`, the run is left as it is: the caller puts
   * it back in the queue to resume it later from the log.
   */
  pauseSignal?: AbortSignal;
}

/** Consecutive turns without a tool call (other than a rejected finish) before the run fails. */
export const MAX_NO_PROGRESS_TURNS = 3;
/** The same call with the same result this many times in a row triggers a nudge. */
export const REPEAT_NUDGE_AT = 3;
/** ... and this many fails the run. */
export const REPEAT_FAIL_AT = 5;
/** Loop-level retries of a retryable provider error (the adapter already retried). */
export const MAX_MODEL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const SUMMARY_MAX_OUTPUT_TOKENS = 4096;

const NOT_ALONE_FINISH =
  "call finish alone, after you have seen the results of the other tools; it was rejected because other tool calls were in the same turn";
const NOT_ALONE_ESCALATE =
  "escalate must be the only tool call of its turn. Call it alone, after you have seen the results of the other tools.";

export const INTERRUPTED_RESULT =
  "interrupted — the result is unknown; check the actual state before repeating this action";

interface TransitionExtra {
  failure?: { origin: FailureOrigin; detail: string };
  result?: RunResult;
  /** Inbox items this change delivers (a cancellation asked for through the inbox). */
  inboxIds?: string[];
  /** Pausing for the user: see `StatusChange.requeueIfInbox`. */
  requeueIfInbox?: boolean;
  /**
   * Inbox items to acknowledge once the change is in the log and before it is applied. A change
   * to a finished status releases the lease, after which the store may no longer be written to,
   * so the acknowledgement has to come in between.
   */
  ackInboxIds?: string[];
}

class Interrupted extends Error {
  override readonly name = "Interrupted";
}

type CallOutcome =
  | { kind: "ok"; result: GenerateResult }
  | { kind: "aborted" }
  | { kind: "error"; error: ProviderError };

interface CallSpec {
  purpose: "agent" | "review" | "compaction";
  provider: Provider;
  model: { id: string; maxOutputTokens: number; pricing?: ModelPricing };
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  toolChoice?: ToolChoice;
  retries: number;
}

interface ControlCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Runs one run until it reaches a terminal or waiting status, and returns that status.
 *
 * It can be started on a run that is `queued`, `running` (fresh or resumed after a crash) or
 * `waiting_user` (with an answer in the inbox). It returns immediately, changing nothing, for a
 * terminal run, a run waiting for approval, and a `waiting_user` run with no answer yet. It
 * returns `running` only when interrupted through `opts.signal`.
 *
 * Store errors are not caught: if the store is down the promise rejects and the run stays as it
 * was, to be resumed from its events.
 */
export async function runLoop(
  deps: LoopDeps,
  runId: string,
  opts: RunLoopOptions = {},
): Promise<RunStatus> {
  return new RunLoop(deps, runId, opts).run();
}

class RunLoop {
  readonly #deps: LoopDeps;
  readonly #runId: string;
  readonly #signal: AbortSignal | undefined;
  readonly #pauseSignal: AbortSignal | undefined;
  readonly #toolSignal: AbortSignal;
  #state: RunState = rebuildState([]);
  #run!: RunRecord;

  constructor(deps: LoopDeps, runId: string, opts: RunLoopOptions) {
    this.#deps = deps;
    this.#runId = runId;
    this.#signal = opts.signal;
    this.#pauseSignal = opts.pauseSignal;
    this.#toolSignal = opts.signal ?? new AbortController().signal;
  }

  async run(): Promise<RunStatus> {
    try {
      return await this.#main();
    } catch (error) {
      if (error instanceof Interrupted) return "running";
      // The lease is gone: someone else owns the run now. Nothing more may be written (not even a
      // failure), so the error goes straight to the caller, who drops the run.
      if (error instanceof LeaseLostError) throw error;
      throw error;
    }
  }

  // --- recording -------------------------------------------------------------------------

  async #record(event: RunEventData): Promise<void> {
    const { seq } = await this.#deps.store.appendEvent(this.#runId, event);
    applyEvent(this.#state, { ...event, seq, createdAt: this.#deps.now() } as StoredEvent);
  }

  /** Records the status change in the log first, then applies it to the store (compare-and-set). */
  async #transition(from: RunStatus, to: RunStatus, extra: TransitionExtra = {}): Promise<boolean> {
    // The log can be ahead of the store: a process that died after logging this very change but
    // before applying it. The change is then only applied, never logged twice.
    if (this.#state.status !== to) {
      await this.#recordStatus(from, to, extra);
    }
    if (extra.ackInboxIds !== undefined && extra.ackInboxIds.length > 0) {
      await this.#deps.store.ackInbox(this.#runId, extra.ackInboxIds);
    }
    return this.#deps.store.setStatus(this.#runId, {
      from: [from],
      to,
      ...(extra.failure === undefined ? {} : { failure: extra.failure }),
      ...(extra.result === undefined ? {} : { result: extra.result }),
      ...(extra.requeueIfInbox === true ? { requeueIfInbox: true } : {}),
    });
  }

  async #recordStatus(from: RunStatus, to: RunStatus, extra: TransitionExtra): Promise<void> {
    await this.#record({
      type: "status_changed",
      payload: {
        from,
        to,
        ...(extra.failure === undefined ? {} : { failure: extra.failure }),
        ...(extra.result === undefined ? {} : { result: extra.result }),
        ...(extra.inboxIds === undefined ? {} : { inboxIds: extra.inboxIds }),
      },
    });
  }

  /** Ends the working phase with `to`; returns the status the run really has afterwards. */
  async #end(to: RunStatus, extra: TransitionExtra = {}): Promise<RunStatus> {
    const applied = await this.#transition("running", to, extra);
    return applied ? to : (await this.#deps.store.getRun(this.#runId)).status;
  }

  #fail(origin: FailureOrigin, detail: string): Promise<RunStatus> {
    return this.#end("failed", { failure: { origin, detail } });
  }

  async #nudge(reason: string, text: string): Promise<void> {
    await this.#record({ type: "nudge", payload: { reason, text } });
  }

  // --- start and resume ------------------------------------------------------------------

  async #main(): Promise<RunStatus> {
    const { store } = this.#deps;
    this.#state = rebuildState(await store.listEvents(this.#runId));
    this.#run = await store.getRun(this.#runId);
    // A previous process may have died between recording an inbox delivery and acknowledging it.
    await this.#freshInbox();

    const gate = this.#run.status;
    if (
      gate === "done" ||
      gate === "failed" ||
      gate === "cancelled" ||
      gate === "waiting_approval"
    ) {
      return gate;
    }

    if (!this.#state.started) {
      await this.#record({
        type: "run_started",
        payload: {
          botId: this.#run.botId,
          objective: this.#run.objective,
          acceptanceCriteria: this.#run.acceptanceCriteria,
          origin: this.#run.origin,
        },
      });
    }

    // The log is the truth. If the process died after logging a status change but before the
    // store applied it, apply it now.
    // The store may also say `queued`: a run that was requeued (a stale lease, or a user's answer
    // posted to a waiting run) and picked up again keeps the status its log last announced.
    const logged = this.#state.status;
    if (
      (this.#run.status === "running" || this.#run.status === "queued") &&
      (logged === "done" ||
        logged === "failed" ||
        logged === "cancelled" ||
        logged === "waiting_user")
    ) {
      const { failure, result } = this.#state.statusDetail;
      await store.setStatus(this.#runId, {
        from: [this.#run.status],
        to: logged,
        ...(failure === undefined ? {} : { failure }),
        ...(result === undefined ? {} : { result }),
      });
      this.#run = await store.getRun(this.#runId);
      if (this.#run.status !== "waiting_user") return this.#run.status;
    }

    if (this.#run.status === "queued") {
      if (!(await this.#transition("queued", "running"))) {
        return (await store.getRun(this.#runId)).status;
      }
    } else if (this.#run.status === "waiting_user") {
      const resumed = await this.#resumeFromWaiting();
      if (resumed !== undefined) return resumed;
    }

    return this.#loop();
  }

  /** `undefined` means the run is running again and the loop should go on. */
  async #resumeFromWaiting(): Promise<RunStatus | undefined> {
    const { store } = this.#deps;
    const waiting = this.#state.waiting;
    if (waiting !== null) {
      const items = await this.#freshInbox();
      const messages = items.filter((i) => i.kind === "user_message");
      const stops = items.filter((i) => i.kind === "stop");
      if (stops.length > 0) {
        for (const item of messages) await this.#recordUserMessage(item);
        const ok = await this.#transition("waiting_user", "cancelled", {
          inboxIds: stops.map((i) => i.id),
          ackInboxIds: items.map((i) => i.id),
        });
        return ok ? "cancelled" : (await store.getRun(this.#runId)).status;
      }
      if (messages.length === 0) return "waiting_user";
      if (waiting.kind === "escalate") {
        // The answer is the result of the pending escalate call.
        await this.#record({
          type: "tool_result",
          payload: {
            callId: waiting.callId,
            outcome: "ok",
            content: messages.map((i) => (i.kind === "user_message" ? i.text : "")).join("\n\n"),
            isError: false,
            truncated: false,
            durationMs: 0,
            inboxIds: messages.map((i) => i.id),
          },
        });
      } else {
        for (const item of messages) await this.#recordUserMessage(item);
      }
      await store.ackInbox(
        this.#runId,
        messages.map((i) => i.id),
      );
    }
    const ok = await this.#transition("waiting_user", "running");
    return ok ? undefined : (await store.getRun(this.#runId)).status;
  }

  /**
   * Items still in the inbox that the log does not deliver yet. Items the log already delivers
   * (the process died before acknowledging them) are acknowledged here and left out.
   */
  async #freshInbox(): Promise<InboxItem[]> {
    const { store } = this.#deps;
    const items = await store.peekInbox(this.#runId);
    const delivered = this.#state.deliveredInbox;
    const stale = items.filter((i) => delivered.has(i.id));
    if (stale.length > 0) {
      await store.ackInbox(
        this.#runId,
        stale.map((i) => i.id),
      );
    }
    return items.filter((i) => !delivered.has(i.id));
  }

  async #recordUserMessage(item: InboxItem): Promise<void> {
    if (item.kind !== "user_message") return;
    await this.#record({ type: "user_message", payload: { text: item.text, inboxId: item.id } });
  }

  // --- the loop --------------------------------------------------------------------------

  async #loop(): Promise<RunStatus> {
    const { store, bot } = this.#deps;
    for (;;) {
      if (this.#signal?.aborted) return "running";

      // Work left from a response already recorded (this process's, or a dead one's).
      const mid = await this.#processPending();
      if (mid !== undefined) return mid;

      // ---- safe point: every result is recorded, no model call is in flight ----
      await store.heartbeat(this.#runId);

      const settled = await this.#settle();
      if (settled !== undefined) return settled;

      // Soft stop: this is the safe point after a whole turn. Nothing else is started.
      if (this.#pauseSignal?.aborted) return "running";

      const inbox = await this.#deliverInbox();
      if (inbox !== undefined) return inbox;

      this.#run = await store.getRun(this.#runId);
      const limit = this.#checkLimits();
      if (limit !== undefined) return this.#fail("limit", limit);

      const guard = await this.#checkGuards();
      if (guard !== undefined) return guard;

      const { system, tools } = this.#fixedParts();
      const estimate = estimateTokens(this.#state, system.length + JSON.stringify(tools).length);
      if (estimate > COMPACTION_THRESHOLD * bot.model.contextWindow) {
        await this.#compact();
      }

      const turn = await this.#modelTurn();
      if (turn !== undefined) return turn;
    }
  }

  /** Acts on decisions the log already holds but the store does not reflect yet. */
  async #settle(): Promise<RunStatus | undefined> {
    const state = this.#state;
    if (state.acceptedFinish !== null) {
      const { summary, evidence } = state.acceptedFinish;
      return this.#end("done", { result: { summary, evidence } });
    }
    if (state.waiting !== null) {
      const ok = await this.#transition("running", "waiting_user", { requeueIfInbox: true });
      return ok ? "waiting_user" : (await this.#deps.store.getRun(this.#runId)).status;
    }
    return undefined;
  }

  /** Delivers what was posted while the run worked: user messages, or a request to stop. */
  async #deliverInbox(): Promise<RunStatus | undefined> {
    const { store } = this.#deps;
    const items = await this.#freshInbox();
    if (items.length === 0) return undefined;
    for (const item of items) await this.#recordUserMessage(item);
    const stops = items.filter((i) => i.kind === "stop");
    if (stops.length > 0) {
      // The cancellation is logged, then the items are acknowledged, then it is applied (it
      // releases the lease, after which no write is allowed).
      return this.#end("cancelled", {
        inboxIds: stops.map((i) => i.id),
        ackInboxIds: items.map((i) => i.id),
      });
    }
    // Only now, with the delivering events in the log, may the store forget the items.
    await store.ackInbox(
      this.#runId,
      items.map((i) => i.id),
    );
    return undefined;
  }

  #checkLimits(): string | undefined {
    const { limits } = this.#deps.bot;
    const run = this.#run;
    if (run.turns >= limits.maxTurns) {
      return `turn limit reached: ${run.turns} of ${limits.maxTurns} model calls used`;
    }
    if (limits.maxCostUsd !== undefined && run.costUsd >= limits.maxCostUsd) {
      return `cost limit reached: $${run.costUsd.toFixed(4)} spent of $${limits.maxCostUsd} allowed`;
    }
    if (limits.maxDurationMs !== undefined) {
      const elapsed = this.#deps.now().getTime() - run.startedAt.getTime();
      if (elapsed >= limits.maxDurationMs) {
        return `duration limit reached: ${Math.round(elapsed / 1000)}s elapsed of ${Math.round(limits.maxDurationMs / 1000)}s allowed`;
      }
    }
    return undefined;
  }

  async #checkGuards(): Promise<RunStatus | undefined> {
    const { noProgressStreak, repeat } = this.#state;
    if (noProgressStreak >= MAX_NO_PROGRESS_TURNS) {
      return this.#fail(
        "model",
        `the model made ${noProgressStreak} consecutive turns without a tool call other than a rejected finish, instead of working or finishing properly`,
      );
    }
    if (repeat.count >= REPEAT_FAIL_AT) {
      return this.#fail(
        "model",
        `the model repeated the same "${repeat.name}" call with identical arguments and an identical result ${repeat.count} times in a row`,
      );
    }
    if (repeat.count >= REPEAT_NUDGE_AT && !repeat.nudged) {
      await this.#nudge("repetition", repetitionNudge(repeat.name, repeat.count));
    }
    return undefined;
  }

  // --- the model call ----------------------------------------------------------------------

  #fixedParts(): { system: string; tools: ToolSpec[] } {
    const { bot, tools } = this.#deps;
    const control = new Set<string>(CONTROL_TOOL_NAMES);
    return {
      system: buildSystemPrompt(bot),
      tools: [
        ...controlToolSpecs(),
        ...tools.specs(bot.allowedTools).filter((spec) => !control.has(spec.name)),
      ],
    };
  }

  /** The request for the next turn: the rebuilt conversation plus the STATE REMINDER. */
  #buildRequest(): { messages: Message[]; problems: string[] } {
    const state = this.#state;
    const problems = validateConversation(state.messages);
    const last = state.messages[state.messages.length - 1];
    if (last === undefined || last.role !== "user") {
      problems.push("the conversation does not end with a user message");
    }
    const messages = structuredClone(state.messages);
    const tail = messages[messages.length - 1];
    if (tail !== undefined && tail.role === "user") {
      // A reminder already in the tail belongs to a request that was never answered (it failed
      // and is being rebuilt, or the process died): replace it with the current one.
      tail.blocks = tail.blocks.filter((b) => !isReminderBlock(b));
      tail.blocks.push({
        type: "text",
        text: renderStateReminder({
          objective: this.#run.objective,
          acceptanceCriteria: this.#run.acceptanceCriteria,
          plan: state.plan,
        }),
      });
    }
    return { messages, problems };
  }

  async #modelTurn(): Promise<RunStatus | undefined> {
    const { bot, provider } = this.#deps;
    let overflowRetried = false;
    for (;;) {
      const { system, tools } = this.#fixedParts();
      const { messages, problems } = this.#buildRequest();
      if (problems.length > 0) {
        return this.#fail(
          "harness",
          `the rebuilt conversation is invalid, so no request was sent: ${problems.join("; ")}`,
        );
      }
      const outcome = await this.#callModel({
        purpose: "agent",
        provider,
        model: bot.model,
        system,
        messages,
        tools,
        retries: MAX_MODEL_RETRIES,
      });
      if (outcome.kind === "ok") return undefined;
      if (outcome.kind === "aborted") throw new Interrupted();

      const { error } = outcome;
      if (error.kind === "context_overflow" && !overflowRetried) {
        overflowRetried = true;
        if (await this.#compact()) continue;
        return this.#fail(
          "limit",
          "the provider reported the context window as exceeded and the conversation cannot be compacted any further",
        );
      }
      return this.#fail("provider", `${error.kind}: ${error.message}`);
    }
  }

  /**
   * One logical model call. Records the request once, then each failed attempt as a
   * `model_error`, and the response; adds usage to the run. Retries retryable errors with backoff.
   */
  async #callModel(spec: CallSpec): Promise<CallOutcome> {
    const { store, now, sleep } = this.#deps;
    const reusable = this.#state.sideResponse;
    if (
      spec.purpose !== "agent" &&
      reusable !== null &&
      reusable.purpose === spec.purpose &&
      reusable.seq === this.#state.lastSeq
    ) {
      // A previous process got this answer and died before using it.
      return { kind: "ok", result: reusable.result };
    }
    const purposeField = spec.purpose === "agent" ? {} : { purpose: spec.purpose };
    const choiceField = spec.toolChoice === undefined ? {} : { toolChoice: spec.toolChoice };
    await this.#record({
      type: "model_request",
      payload: {
        provider: spec.provider.id,
        model: spec.model.id,
        system: spec.system,
        messages: spec.messages,
        tools: spec.tools,
        ...choiceField,
        maxOutputTokens: spec.model.maxOutputTokens,
        ...purposeField,
      },
    });

    for (let attempt = 1; ; attempt++) {
      const startedAt = now();
      let result: GenerateResult | undefined;
      let failure: ProviderError | undefined;
      try {
        result = await generateAndCollect(spec.provider, {
          model: spec.model.id,
          system: spec.system,
          messages: spec.messages,
          tools: spec.tools,
          ...choiceField,
          maxOutputTokens: spec.model.maxOutputTokens,
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
        });
      } catch (caught) {
        failure = toProviderError(caught);
      }

      if (result !== undefined) {
        // Usage first: if the process dies before the response is logged, the money was still
        // spent, so over-counting is the right way to be wrong.
        await store.addUsage(this.#runId, {
          turns: spec.purpose === "agent" ? 1 : 0,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: computeCost(result.usage, spec.model.pricing),
        });
        await this.#record({
          type: "model_response",
          payload: {
            blocks: result.blocks,
            stopReason: result.stopReason,
            usage: result.usage,
            modelVersion: result.modelVersion,
            durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
            ...purposeField,
          },
        });
        return { kind: "ok", result };
      }

      const error = failure as ProviderError;
      await this.#record({
        type: "model_error",
        payload: {
          kind: error.kind,
          message: error.message,
          retryable: error.retryable,
          attempt,
          ...purposeField,
        },
      });
      if (error.kind === "aborted" && this.#signal?.aborted) return { kind: "aborted" };
      if (!error.retryable || attempt > spec.retries) return { kind: "error", error };
      await sleep(error.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      if (this.#signal?.aborted) return { kind: "aborted" };
    }
  }

  // --- compaction --------------------------------------------------------------------------

  /** Summarizes the oldest part of the conversation. Returns false when there is nothing to cut. */
  async #compact(): Promise<boolean> {
    const { bot, provider } = this.#deps;
    const state = this.#state;
    const cut = chooseCutIndex(state.messages);
    const uptoSeq = cut === null ? undefined : state.messageSeqs[cut - 1];
    if (cut === null || uptoSeq === undefined) return false;

    const dropped = state.messages.slice(0, cut);
    const transcript = renderTranscript(dropped, Math.floor(bot.model.contextWindow * 4 * 0.5));
    const outcome = await this.#callModel({
      purpose: "compaction",
      provider,
      model: {
        ...bot.model,
        maxOutputTokens: Math.min(bot.model.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS),
      },
      system: COMPACTION_SYSTEM,
      messages: [
        {
          role: "user",
          blocks: [
            {
              type: "text",
              text: `Summarize this earlier part of the conversation:\n\n${transcript}`,
            },
          ],
        },
      ],
      tools: [],
      retries: 0,
    });
    if (outcome.kind === "aborted") throw new Interrupted();

    let summary = "";
    let warning = "";
    if (outcome.kind === "error") {
      warning = `summarizing failed (${outcome.error.kind}: ${outcome.error.message})`;
    } else {
      summary = outcome.result.blocks
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      if (summary === "") warning = "the summarizer returned no text";
    }

    if (warning === "") {
      await this.#record({
        type: "compacted",
        payload: { summary, uptoSeq, droppedMessages: dropped.length },
      });
    } else {
      await this.#record({
        type: "compacted",
        payload: {
          summary: `[The earlier part of the conversation (${dropped.length} messages) was dropped because it could not be summarized. Do not rely on what it contained: check the actual state (files, tool results) before acting on anything done earlier.]`,
          uptoSeq,
          droppedMessages: dropped.length,
          degraded: true,
          warning,
        },
      });
    }
    return true;
  }

  // --- acting on a response ----------------------------------------------------------------

  async #processPending(): Promise<RunStatus | undefined> {
    const pending = this.#state.pending;
    if (pending === null) return undefined;
    if (pending.stopReason === "refusal") {
      return this.#fail(
        "model",
        `the model refused to continue${textOf(pending) === "" ? "" : `: ${textOf(pending).slice(0, 300)}`}`,
      );
    }
    if (pending.toolCalls.length === 0) return this.#handleTextOnly(pending);
    return this.#executeCalls(pending);
  }

  async #handleTextOnly(pending: PendingResponse): Promise<RunStatus | undefined> {
    const state = this.#state;
    const text = textOf(pending);
    let reason: string;
    let nudge: string;
    if (pending.stopReason === "max_tokens") {
      reason = "output_truncated";
      nudge = TRUNCATED_NUDGE;
    } else if (text === "") {
      reason = "empty_response";
      nudge = EMPTY_RESPONSE_NUDGE;
    } else if (!state.hasPlan) {
      // A simple question: the text is the answer.
      return this.#end("done", { result: { summary: text } });
    } else {
      reason = "stopped_without_finish";
      nudge = stoppedWithOpenStepsNudge(state.plan);
    }
    if (state.noProgressStreak + 1 >= MAX_NO_PROGRESS_TURNS) {
      return this.#fail(
        "model",
        `the model made ${state.noProgressStreak + 1} consecutive turns without any tool call (${reason}) instead of working or calling finish`,
      );
    }
    await this.#nudge(reason, nudge);
    return undefined;
  }

  async #executeCalls(pending: PendingResponse): Promise<RunStatus | undefined> {
    const alone = pending.toolCalls.length === 1;
    for (const call of pending.toolCalls) {
      const open = this.#state.pendingCalls.find((c) => c.id === call.id);
      if (open === undefined) continue; // already has a result
      const waiting = this.#state.waiting;
      if (waiting?.kind === "escalate" && waiting.callId === call.id) continue;

      if (this.#signal?.aborted) {
        await this.#abortRemaining();
        return "running";
      }
      await this.#deps.store.heartbeat(this.#runId);

      switch (call.name) {
        case "plan":
          await this.#handlePlan(call);
          break;
        case "finish":
          await this.#handleFinish(call, alone);
          break;
        case "escalate":
          await this.#handleEscalate(call, alone);
          break;
        default:
          await this.#handleTool(call, open.started);
      }
    }
    return undefined;
  }

  /** Gives every call that has no result yet an "interrupted" one, keeping the pairing valid. */
  async #abortRemaining(): Promise<void> {
    for (const call of [...this.#state.pendingCalls]) {
      await this.#result(call.id, {
        outcome: "aborted",
        isError: true,
        content: call.started
          ? `Tool "${call.name}": ${INTERRUPTED_RESULT}.`
          : `Tool "${call.name}" was not run: the run was interrupted before this call started. Check the actual state before repeating the action, if it still applies.`,
      });
    }
  }

  async #ensureToolCall(call: ControlCall): Promise<void> {
    const open = this.#state.pendingCalls.find((c) => c.id === call.id);
    if (open?.started) return;
    await this.#record({
      type: "tool_call",
      payload: { callId: call.id, name: call.name, args: call.args as never },
    });
  }

  async #result(
    callId: string,
    r: {
      outcome: ToolInvocation["outcome"];
      isError: boolean;
      content: string;
      truncated?: boolean;
      durationMs?: number;
    },
  ): Promise<void> {
    await this.#record({
      type: "tool_result",
      payload: {
        callId,
        outcome: r.outcome,
        content: r.content,
        isError: r.isError,
        truncated: r.truncated ?? false,
        durationMs: r.durationMs ?? 0,
      },
    });
  }

  async #handleTool(call: ControlCall, started: boolean): Promise<void> {
    const { tools, bot, executor, now } = this.#deps;
    if (started) {
      // The process died after logging the call and before logging its result: the action may or
      // may not have happened. Say so, and let the model check.
      await this.#result(call.id, {
        outcome: "aborted",
        isError: true,
        content: `Tool "${call.name}": ${INTERRUPTED_RESULT}.`,
      });
      return;
    }
    await this.#ensureToolCall(call);
    const ctx: ToolContext = {
      runId: this.#runId,
      botId: bot.id,
      executor,
      signal: this.#toolSignal,
      now: () => now(),
    };
    let invocation: ToolInvocation;
    try {
      invocation = await tools.invoke(call.name, call.args, ctx, {
        allowed: bot.allowedTools,
        callId: call.id,
      });
    } catch (error) {
      await this.#result(call.id, {
        outcome: "crashed",
        isError: true,
        content: `Tool "${call.name}" failed unexpectedly (${error instanceof Error ? error.message : String(error)}). Try a different approach.`,
      });
      return;
    }
    await this.#result(call.id, {
      outcome: invocation.outcome,
      isError: invocation.output.isError === true,
      content: invocation.output.content,
      truncated: invocation.truncated,
      durationMs: invocation.durationMs,
    });
  }

  // --- control tools -----------------------------------------------------------------------

  async #handlePlan(call: ControlCall): Promise<void> {
    await this.#ensureToolCall(call);
    const parsed = planInputSchema.safeParse(call.args);
    if (!parsed.success) {
      await this.#result(call.id, {
        outcome: "invalid_args",
        isError: true,
        content: renderArgIssues("plan", parsed.error),
      });
      return;
    }
    const steps: PlanStep[] = parsed.data.steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      ...(s.note === undefined ? {} : { note: s.note }),
    }));
    const problems = validatePlan(steps, this.#state.plan);
    if (problems.length > 0) {
      await this.#result(call.id, {
        outcome: "tool_error",
        isError: true,
        content: `The plan was not saved:\n${formatReasons(problems)}\nSend the complete corrected plan.`,
      });
      return;
    }
    // On resume the plan may already be recorded; do not log it twice.
    if (canonicalJson(steps) !== canonicalJson(this.#state.plan)) {
      await this.#record({ type: "plan_updated", payload: { plan: steps } });
    }
    await this.#deps.store.updatePlan(this.#runId, steps);
    await this.#result(call.id, { outcome: "ok", isError: false, content: describePlan(steps) });
  }

  async #handleEscalate(call: ControlCall, alone: boolean): Promise<void> {
    await this.#ensureToolCall(call);
    const parsed = escalateInputSchema.safeParse(call.args);
    if (!parsed.success) {
      await this.#result(call.id, {
        outcome: "invalid_args",
        isError: true,
        content: renderArgIssues("escalate", parsed.error),
      });
      return;
    }
    if (!alone) {
      await this.#result(call.id, {
        outcome: "tool_error",
        isError: true,
        content: NOT_ALONE_ESCALATE,
      });
      return;
    }
    if (parsed.data.question.trim() === "") {
      await this.#result(call.id, {
        outcome: "invalid_args",
        isError: true,
        content: "The question is empty. Call escalate again with one precise question.",
      });
      return;
    }
    // No result is recorded: the user's answer will be it. The loop pauses at the next safe point.
    await this.#record({
      type: "escalated",
      payload: { question: parsed.data.question, callId: call.id },
    });
  }

  async #handleFinish(call: ControlCall, alone: boolean): Promise<void> {
    await this.#ensureToolCall(call);
    const parsed = finishInputSchema.safeParse(call.args);
    if (!parsed.success) {
      await this.#result(call.id, {
        outcome: "invalid_args",
        isError: true,
        content: renderArgIssues("finish", parsed.error),
      });
      return;
    }
    const args = parsed.data;

    let attempt = this.#state.finishAttempts.get(call.id);
    if (attempt === undefined) attempt = await this.#decideFinish(call, args, alone);

    if (attempt.accepted) {
      await this.#result(call.id, {
        outcome: "ok",
        isError: false,
        content: "Finish accepted. The run is complete.",
      });
      return;
    }
    if (attempt.handedToUser && this.#state.waiting === null && !this.#state.reviewWaived) {
      // Died between logging the attempt and logging the question.
      await this.#recordTieBreak(args.summary);
    }
    await this.#result(call.id, {
      outcome: "tool_error",
      isError: true,
      content: `Finish was not accepted:\n${formatReasons(attempt.reasons)}`,
    });
  }

  async #decideFinish(
    call: ControlCall,
    args: { summary: string; evidence: { criterion: string; evidence: string }[] },
    alone: boolean,
  ): Promise<{ accepted: boolean; reasons: string[]; handedToUser: boolean }> {
    const { reviewer } = this.#deps;
    const state = this.#state;
    const reject = async (reasons: string[], handedToUser = false) => {
      await this.#record({
        type: "finish_attempt",
        payload: {
          callId: call.id,
          summary: args.summary,
          evidence: args.evidence,
          accepted: false,
          rejectionReasons: reasons,
          ...(handedToUser ? { handedToUser: true } : {}),
        },
      });
      return { accepted: false, reasons, handedToUser };
    };

    const reasons = alone
      ? validateFinish(args, this.#run.acceptanceCriteria, state.plan)
      : [NOT_ALONE_FINISH];
    if (reasons.length > 0) return reject(reasons);

    if (reviewer !== undefined && !state.reviewWaived) {
      let review = state.currentReview;
      if (review === null) {
        if (state.reviewRejections >= (reviewer.maxRejections ?? DEFAULT_MAX_REJECTIONS)) {
          const outcome = await reject(
            [
              `An independent reviewer rejected this work ${state.reviewRejections} times and still disagrees (its last objection: ${state.lastRejectionNotes}). The decision has been handed to the user. Wait for their reply; do not call finish again before it.`,
            ],
            true,
          );
          await this.#recordTieBreak(args.summary);
          return outcome;
        }
        review = await this.#review(call, args);
      }
      if (review.verdict === "reject") {
        return reject([`An independent reviewer rejected the finish: ${review.notes}`]);
      }
    }

    await this.#record({
      type: "finish_attempt",
      payload: {
        callId: call.id,
        summary: args.summary,
        evidence: args.evidence,
        accepted: true,
        rejectionReasons: [],
      },
    });
    return { accepted: true, reasons: [], handedToUser: false };
  }

  async #recordTieBreak(summary: string): Promise<void> {
    await this.#record({
      type: "escalated",
      payload: {
        reason: "review_tie_break",
        question: `I believe the task is complete, but an automated review keeps disagreeing, so I need you to decide.\n\nMy summary:\n${summary}\n\nThe reviewer's last objection:\n${this.#state.lastRejectionNotes}\n\nShould I accept the work as it is, or what should change?`,
      },
    });
  }

  /** Asks the reviewer. Never fails the run: a broken review is an approval with a warning. */
  async #review(
    call: ControlCall,
    args: { summary: string; evidence: { criterion: string; evidence: string }[] },
  ): Promise<{ verdict: "approve" | "reject"; notes: string; warning?: string }> {
    const reviewer = this.#deps.reviewer;
    if (reviewer === undefined) throw new Error("review requested without a reviewer");
    const forced = reviewer.model.supportsForcedToolChoice !== false;
    const reviewSpec: CallSpec = {
      purpose: "review",
      provider: reviewer.provider,
      model: reviewer.model,
      system: REVIEWER_SYSTEM,
      messages: [
        {
          role: "user",
          blocks: [
            {
              type: "text",
              text: buildReviewMessage({
                objective: this.#run.objective,
                acceptanceCriteria: this.#run.acceptanceCriteria,
                plan: this.#state.plan,
                summary: args.summary,
                evidence: args.evidence,
                digest: buildReviewDigest(this.#state.toolLog),
                userExchanges: this.#state.userLog,
              }),
            },
          ],
        },
      ],
      tools: [verdictToolSpec()],
      ...(forced ? { toolChoice: { name: "verdict" } } : {}),
      retries: 0,
    };
    let outcome = await this.#callModel(reviewSpec);
    if (forced && outcome.kind === "error" && outcome.error.kind === "invalid_request") {
      // The model may refuse a forced tool choice without the configuration saying so. Ask once
      // more by instruction only instead of failing the review (the failure stays in the log).
      const { toolChoice: _forced, ...unforced } = reviewSpec;
      outcome = await this.#callModel(unforced);
    }

    if (outcome.kind === "aborted") {
      await this.#result(call.id, {
        outcome: "aborted",
        isError: true,
        content: `Tool "finish": ${INTERRUPTED_RESULT}.`,
      });
      throw new Interrupted();
    }
    const verdict =
      outcome.kind === "ok"
        ? parseVerdict(outcome.result.blocks)
        : {
            verdict: "approve" as const,
            notes: "",
            warning: `the review was skipped because the reviewer failed (${outcome.error.kind}: ${outcome.error.message})`,
          };
    await this.#record({
      type: "review",
      payload: {
        verdict: verdict.verdict,
        notes: verdict.notes,
        ...(verdict.warning === undefined ? {} : { warning: verdict.warning }),
      },
    });
    return verdict;
  }
}

function textOf(pending: PendingResponse): string {
  return pending.blocks
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

export function computeCost(usage: Usage, pricing: ModelPricing | undefined): number {
  if (pricing === undefined) return 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const writeRate = pricing.cacheWriteInputPerMTok ?? pricing.inputPerMTok;
  return (
    ((usage.inputTokens - cached - written) * pricing.inputPerMTok +
      cached * cachedRate +
      written * writeRate +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error), {
    retryable: false,
    cause: error,
  });
}
