import { allowAllGate, createReplayGate } from "./approvals/gate.js";
import type { PlanStep } from "./events.js";
import { parseRunEvent, type RunEventData, type RunStatus } from "./events.js";
import { CONTROL_TOOL_NAMES } from "./loop/control-tools.js";
import {
  type BotConfig,
  type LoopDeps,
  type ReviewerConfig,
  type RunContextSnapshot,
  runLoop,
  type ToolInvoker,
} from "./loop/loop.js";
import { APPROVALS_PROMPT_MARK } from "./loop/prompts.js";
import { canonicalJson } from "./loop/state.js";
import type {
  ApprovalDecisionItem,
  InboxItem,
  RunStore,
  StatusChange,
  UsageDelta,
} from "./loop/store.js";
import type { ProgressJudge } from "./loop/watchdog.js";
import {
  type GenerateRequest,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  type ProviderEvent,
  type ToolSpec,
} from "./provider.js";
import type { InvokeOptions, ToolInvocation } from "./registry.js";
import { noRedaction } from "./secrets.js";
import { InMemoryRunStore } from "./testing/memory-store.js";
import type { Executor, FileStat, ToolContext } from "./tool.js";

// Replay of a recorded run (section 4.13 of the plan): the real loop runs again, but every answer
// comes from the recording. Nothing is called for real: a replay can never repeat a side effect,
// spend money, or depend on a provider being reachable.

/** A recorded event. `createdAt` is used (when present) to give the replay the recording's time. */
export type RecordedEvent = RunEventData & { seq?: number; createdAt?: Date };

type CallPurpose = "agent" | "review" | "compaction" | "progress";

/** What the recording does not have, that the replay asked for. */
export interface ReplayMissing {
  what: "model_response" | "tool_result";
  message: string;
}

/** Thrown by the replay pieces when the recording lacks what is needed. */
export class ReplayMissingError extends Error {
  override readonly name = "ReplayMissingError";
  constructor(readonly missing: ReplayMissing) {
    super(missing.message);
  }
}

/** Thrown by the replay's store once the replay has been stopped. Never escapes `replayRun`. */
class ReplayHalt extends Error {
  override readonly name = "ReplayHalt";
}

// ---------------------------------------------------------------------------------------------
// Provider

type Outcome =
  | { kind: "response"; payload: Extract<RunEventData, { type: "model_response" }>["payload"] }
  | { kind: "error"; payload: Extract<RunEventData, { type: "model_error" }>["payload"] };

export interface ReplayProviderOptions {
  /** Serve only the calls of this purpose. Default: told apart by the request (see below). */
  purpose?: CallPurpose;
  /** Called, before the failure, when the recording has no more answers for the call. */
  onMissing?(missing: ReplayMissing): void;
}

/**
 * A `Provider` that serves a recording instead of calling a model: for each purpose (agent,
 * review, compaction) the recorded `model_response`s and `model_error`s, in order. A recorded
 * error is thrown as the same `ProviderError`, so the loop's retries replay too.
 *
 * Without `options.purpose`, a request without tools is a compaction call and any other is an
 * agent turn (the loop's reviewer has its own provider object; give it its own `ReplayProvider`
 * with `purpose: "review"`). Its `id` is the one recorded for that purpose, so the
 * `provider_data` blocks keep the provider they were stamped with.
 *
 * When the recording runs out it throws a non-retryable `ProviderError` and never anything else:
 * there is no real provider to fall through to.
 */
export class ReplayProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    promptCache: false,
    parallelTools: true,
    vision: false,
  };
  /** Every request received, in order (the abort signal is not kept). */
  readonly requests: Omit<GenerateRequest, "signal">[] = [];
  readonly #queues: Record<CallPurpose, Outcome[]> = {
    agent: [],
    review: [],
    compaction: [],
    progress: [],
  };
  readonly #served: Record<CallPurpose, number> = {
    agent: 0,
    review: 0,
    compaction: 0,
    progress: 0,
  };
  readonly #purpose: CallPurpose | undefined;
  readonly #onMissing: ((missing: ReplayMissing) => void) | undefined;

  constructor(events: readonly RecordedEvent[], options: ReplayProviderOptions = {}) {
    this.#purpose = options.purpose;
    this.#onMissing = options.onMissing;
    let id: string | undefined;
    for (const event of events) {
      if (event.type === "model_request") {
        const purpose = event.payload.purpose ?? "agent";
        if (id === undefined && (this.#purpose === undefined || this.#purpose === purpose)) {
          id = event.payload.provider;
        }
      } else if (event.type === "model_response") {
        this.#queues[event.payload.purpose ?? "agent"].push({
          kind: "response",
          payload: event.payload,
        });
      } else if (event.type === "model_error") {
        this.#queues[event.payload.purpose ?? "agent"].push({
          kind: "error",
          payload: event.payload,
        });
      }
    }
    this.id = id ?? "replay";
  }

  /** Answers not served yet, over all purposes. */
  get remaining(): number {
    return (["agent", "review", "compaction", "progress"] as const).reduce(
      (sum, p) => sum + this.#queues[p].length - this.#served[p],
      0,
    );
  }

  generate(req: GenerateRequest): AsyncIterable<ProviderEvent> {
    const { signal: _signal, ...rest } = req;
    this.requests.push(structuredClone(rest));
    const purpose: CallPurpose = this.#purpose ?? (req.tools.length === 0 ? "compaction" : "agent");
    const outcome = this.#queues[purpose][this.#served[purpose]];
    const callNumber = this.#served[purpose] + 1;
    this.#served[purpose] += 1;
    if (outcome === undefined) {
      const missing: ReplayMissing = {
        what: "model_response",
        message: `the recording has no ${purpose} model response number ${callNumber}: the replay made a model call the original run did not`,
      };
      this.#onMissing?.(missing);
      return this.#fail(new ProviderError("unknown", missing.message, { retryable: false }));
    }
    if (outcome.kind === "error") {
      const { kind, message, retryable } = outcome.payload;
      return this.#fail(new ProviderError(kind, message, { retryable }));
    }
    return this.#serve(outcome.payload);
  }

  // biome-ignore lint/correctness/useYield: it only throws
  async *#fail(error: ProviderError): AsyncGenerator<ProviderEvent> {
    throw error;
  }

  async *#serve(
    payload: Extract<RunEventData, { type: "model_response" }>["payload"],
  ): AsyncGenerator<ProviderEvent> {
    for (const block of payload.blocks) {
      switch (block.type) {
        case "text":
          yield { type: "text_delta", text: block.text };
          break;
        case "tool_call":
          yield { type: "tool_call", id: block.id, name: block.name, args: block.args };
          break;
        case "provider_data":
          yield { type: "provider_data", data: block.data };
          break;
        case "tool_result":
          throw new Error("replay: a recorded response cannot contain tool_result blocks");
      }
    }
    yield {
      type: "usage",
      inputTokens: payload.usage.inputTokens,
      outputTokens: payload.usage.outputTokens,
      ...(payload.usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: payload.usage.cachedInputTokens }),
      ...(payload.usage.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: payload.usage.cacheWriteInputTokens }),
    };
    yield { type: "done", stopReason: payload.stopReason, modelVersion: payload.modelVersion };
  }
}

// ---------------------------------------------------------------------------------------------
// Tools

export interface ReplayInvokerOptions {
  /**
   * Where the model-visible tool specs come from. Default: the ones recorded in the first agent
   * request (without the control tools). Pass the current registry to see a changed tool
   * description as a request diff.
   */
  specs?: Pick<ToolInvoker, "specs">;
  onMissing?(missing: ReplayMissing): void;
}

/**
 * A `ToolInvoker` that executes nothing: `invoke` returns the recorded `tool_result` of the call
 * (by call id). A replay therefore never repeats a side effect. A call the recording has no result
 * for is reported through `onMissing` and fails with `ReplayMissingError`; it is never run.
 */
export class ReplayInvoker implements ToolInvoker {
  readonly #results = new Map<string, Extract<RunEventData, { type: "tool_result" }>["payload"]>();
  readonly #names = new Map<string, string>();
  readonly #recordedSpecs: ToolSpec[];
  readonly #current: Pick<ToolInvoker, "specs"> | undefined;
  readonly #onMissing: ((missing: ReplayMissing) => void) | undefined;
  /** Calls answered from the recording, in order. */
  readonly served: string[] = [];

  constructor(events: readonly RecordedEvent[], options: ReplayInvokerOptions = {}) {
    this.#current = options.specs;
    this.#onMissing = options.onMissing;
    const control = new Set<string>(CONTROL_TOOL_NAMES);
    let specs: ToolSpec[] | undefined;
    for (const event of events) {
      if (event.type === "tool_result" && !this.#results.has(event.payload.callId)) {
        this.#results.set(event.payload.callId, event.payload);
      } else if (event.type === "tool_call") {
        this.#names.set(event.payload.callId, event.payload.name);
      } else if (
        event.type === "model_request" &&
        specs === undefined &&
        (event.payload.purpose ?? "agent") === "agent"
      ) {
        specs = event.payload.tools.filter((t) => !control.has(t.name));
      }
    }
    this.#recordedSpecs = specs ?? [];
  }

  specs(allowed?: string[]): ToolSpec[] {
    if (this.#current !== undefined) return this.#current.specs(allowed);
    const filter = allowed === undefined ? undefined : new Set(allowed);
    return structuredClone(
      this.#recordedSpecs.filter((spec) => filter === undefined || filter.has(spec.name)),
    );
  }

  async invoke(
    name: string,
    _rawArgs: unknown,
    _ctx: ToolContext,
    opts: InvokeOptions = {},
  ): Promise<ToolInvocation> {
    const callId = opts.callId;
    const recorded = callId === undefined ? undefined : this.#results.get(callId);
    if (callId === undefined || recorded === undefined) {
      const missing: ReplayMissing = {
        what: "tool_result",
        message:
          callId === undefined
            ? `the replay called tool "${name}" without a call id, so no recorded result can be found`
            : `the recording has no result for tool call ${callId} ("${name}")`,
      };
      this.#onMissing?.(missing);
      throw new ReplayMissingError(missing);
    }
    this.served.push(callId);
    return {
      output: {
        content: recorded.content,
        ...(recorded.isError ? { isError: true } : {}),
        ...(recorded.webUrls === undefined ? {} : { webUrls: recorded.webUrls }),
        ...(recorded.urlProvenance === undefined ? {} : { urlProvenance: recorded.urlProvenance }),
        ...(recorded.source === undefined ? {} : { source: recorded.source }),
      },
      durationMs: recorded.durationMs,
      outcome: recorded.outcome,
      truncated: recorded.truncated,
      ...(recorded.risk === undefined ? {} : { risk: recorded.risk }),
    };
  }
}

/**
 * The machine of a replay: there is none. Anything that reaches for it is a bug in the replay,
 * with one exception: the files the reviewer asked to see. Those are not in the log as tool
 * results, so the recording keeps what was read (`review_evidence`) and this serves it back,
 * read only, under the same path; a path the recording could not supply fails the same way.
 */
class NoMachine implements Executor {
  readonly #files = new Map<string, string>();
  readonly #failures = new Map<string, string>();

  constructor(events: readonly RecordedEvent[]) {
    for (const event of events) {
      if (event.type !== "review_evidence") continue;
      for (const item of event.payload.supplied) {
        if (item.kind === "file") this.#files.set(item.ref, item.content);
      }
      for (const { item, reason } of event.payload.missing) this.#failures.set(item.trim(), reason);
    }
  }

  #refuse(what: string): never {
    throw new Error(`replay: ${what} was attempted, but a replay never touches the machine`);
  }
  async exec(): Promise<never> {
    return this.#refuse("exec");
  }
  async readFile(path: string): Promise<string> {
    const content = this.#files.get(path);
    if (content !== undefined) return content;
    const reason = this.#failures.get(path);
    // A read that failed in the original run fails again with the message it carried.
    if (reason !== undefined) throw new Error(reason.replace(/^could not be read: /, ""));
    return this.#refuse("readFile");
  }
  async writeFile(): Promise<never> {
    return this.#refuse("writeFile");
  }
  async listDir(): Promise<never> {
    return this.#refuse("listDir");
  }
  async stat(path: string): Promise<FileStat | null> {
    const content = this.#files.get(path);
    if (content !== undefined) return { kind: "file", size: content.length };
    const reason = this.#failures.get(path);
    if (reason === undefined) return this.#refuse("stat");
    if (reason.startsWith("no such file")) return null;
    if (reason.startsWith("it is a directory")) return { kind: "dir", size: 0 };
    const large = /\((\d+) bytes/.exec(reason);
    if (large !== null) return { kind: "file", size: Number(large[1]) };
    return { kind: "file", size: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Replay run

export interface ReplayOptions {
  /** The bot as the CURRENT code would run it. Changing it is how a replay tests a change. */
  bot: BotConfig;
  /**
   * The reviewer, when the recording has review calls (it is then inferred from the recording:
   * the recorded model and output limit). Give what differs from the recording, e.g.
   * `maxRejections`.
   */
  reviewer?: Partial<Omit<ReviewerConfig, "provider">>;
  /** Source of the tool specs the model sees. Default: the recorded ones. */
  tools?: Pick<ToolInvoker, "specs">;
}

/** An event reduced to what a replay compares: no timings, no seq, no createdAt. */
export interface ComparableEvent {
  type: RunEventData["type"];
  payload: Record<string, unknown>;
}

export interface Divergence {
  /** Position in the recorded events (the replayed log is compared position by position). */
  index: number;
  /** Absent when the recording ended before this position. */
  recorded: ComparableEvent | undefined;
  /** Absent when the replay stopped or ended before this position. */
  replayed: ComparableEvent | undefined;
  /** Top-level payload fields that differ, when both sides have an event of the same type. */
  changedFields?: string[];
  /** Why the replay could not go on (the recording lacks a response or a tool result). */
  reason?: string;
}

export interface RequestChange {
  field:
    | "provider"
    | "model"
    | "system"
    | "messages"
    | "tools"
    | "hostedToolSearch"
    | "toolChoice"
    | "maxOutputTokens"
    | "temperature";
  recorded: unknown;
  replayed: unknown;
  /** For `messages`: index of the first message that differs. */
  firstMessage?: number;
}

/** A recorded `model_request` and what the current code builds at the same point differ. */
export interface RequestDiff {
  /** Position of the recorded `model_request` in the recorded events. */
  index: number;
  purpose: CallPurpose;
  changes: RequestChange[];
}

export interface ReplayReport {
  /**
   * The replayed log has the same events as the recorded one (timings aside; a `model_request`
   * counts by its position and purpose, its content is in `requestDiffs`), and the run ended in
   * the same status.
   */
  identical: boolean;
  firstDivergence?: Divergence;
  /**
   * Recorded requests that differ from the ones the current code builds. Compared up to the first
   * divergence only: after it the two logs no longer line up. Empty means the same prompts.
   */
  requestDiffs: RequestDiff[];
  finalStatus: { recorded: RunStatus | null; replayed: RunStatus | null };
  /** Set when the replay stopped early because the recording lacked something. */
  stoppedBecause?: string;
  /** The log the replay produced. */
  replayedEvents: ComparableEvent[];
}

/**
 * Runs the real `runLoop` again on a fresh in-memory store, answering every model call and tool
 * call from `events`, and reports how the replay compares with the recording.
 *
 * - The run inputs (objective, criteria, origin) and the initial status come from the recording.
 * - Inbox deliveries (user messages, an answer to `escalate`, a stop) are made available exactly
 *   where the recording delivered them, with the recorded ids and texts.
 * - Time follows the recording (each event's `createdAt`), so duration limits behave the same.
 * - If the replay needs a model response or tool result the recording does not have, it stops
 *   there and reports it as the divergence.
 *
 * Reading the report (plan section 4.13): same events with the same recorded answers means the
 * harness behaved the same; `requestDiffs` show what the model would see now that it did not see
 * then (a prompt or context change); a divergence shows where the harness decides differently
 * given the same answers.
 */
export async function replayRun(
  events: readonly RecordedEvent[],
  options: ReplayOptions,
): Promise<ReplayReport> {
  const recorded: RecordedEvent[] = events.map((event) => ({
    ...parseRunEvent(event.type, event.payload),
    ...(event.seq === undefined ? {} : { seq: event.seq }),
    ...(event.createdAt === undefined ? {} : { createdAt: event.createdAt }),
  }));
  const started = recorded.find((e) => e.type === "run_started");
  if (started === undefined || started.type !== "run_started") {
    throw new Error("replayRun: the recording has no run_started event");
  }
  const firstStatus = recorded.find((e) => e.type === "status_changed");
  const initialStatus: RunStatus =
    firstStatus?.type === "status_changed" ? firstStatus.payload.from : "running";

  const control: { halted: string | undefined } = { halted: undefined };
  const onMissing = (missing: ReplayMissing) => {
    control.halted ??= missing.message;
  };

  let appended = 0;
  const epoch = new Date(0);
  const timeAt = (position: number): Date => {
    const at = recorded[Math.min(position, recorded.length - 1)]?.createdAt;
    return at ?? epoch;
  };
  const clock = () => timeAt(appended);
  const memory = new InMemoryRunStore({ clock });
  const run = memory.createRun({
    id: "replay",
    botId: started.payload.botId,
    objective: started.payload.objective,
    acceptanceCriteria: started.payload.acceptanceCriteria,
    origin: started.payload.origin,
    status: initialStatus,
  });
  const store = new ReplayStore(
    memory,
    recorded,
    control,
    () => appended,
    () => {
      appended += 1;
    },
  );

  const provider = new ReplayProvider(recorded, { onMissing });
  const reviewRequest = recorded.find(
    (e) => e.type === "model_request" && e.payload.purpose === "review",
  );
  let reviewer: ReviewerConfig | undefined;
  if (reviewRequest?.type === "model_request" || options.reviewer !== undefined) {
    const model =
      options.reviewer?.model ??
      (reviewRequest?.type === "model_request"
        ? {
            id: reviewRequest.payload.model,
            maxOutputTokens: reviewRequest.payload.maxOutputTokens,
          }
        : { id: "replay-reviewer", maxOutputTokens: 1024 });
    reviewer = {
      provider: new ReplayProvider(recorded, { purpose: "review", onMissing }),
      model,
      ...(options.reviewer?.maxRejections === undefined
        ? {}
        : { maxRejections: options.reviewer.maxRejections }),
    };
  }
  // The progress judge answered during the recording: it answers again, from the recording.
  const progressRequest = recorded.find(
    (e) => e.type === "model_request" && e.payload.purpose === "progress",
  );
  const judge: ProgressJudge | undefined =
    progressRequest?.type === "model_request"
      ? {
          provider: new ReplayProvider(recorded, { purpose: "progress", onMissing }),
          model: {
            id: progressRequest.payload.model,
            maxOutputTokens: progressRequest.payload.maxOutputTokens,
          },
        }
      : undefined;
  const tools = new ReplayInvoker(recorded, {
    onMissing,
    ...(options.tools === undefined ? {} : { specs: options.tools }),
  });

  // The context of the run is what the recording says it was, never what memory holds now.
  const recordedContext = recorded.find((e) => e.type === "context_loaded");
  const loadRunContext =
    recordedContext?.type === "context_loaded"
      ? async (): Promise<RunContextSnapshot> => structuredClone(recordedContext.payload)
      : undefined;

  // The run was gated if the recording says so: it holds verdicts, or its prompt tells the model
  // about approvals. Same for the vault: the model was offered `request_secret`.
  const firstRequest = recorded.find(
    (e) => e.type === "model_request" && (e.payload.purpose ?? "agent") === "agent",
  );
  const gated =
    recorded.some((e) => e.type === "policy_checked" || e.type === "approval_requested") ||
    (firstRequest?.type === "model_request" &&
      firstRequest.payload.system.includes(APPROVALS_PROMPT_MARK));
  const hadVault =
    firstRequest?.type === "model_request" &&
    firstRequest.payload.tools.some((t) => t.name === "request_secret");

  // The run could schedule returns if the model was offered the tool.
  const hadReturns =
    firstRequest?.type === "model_request" &&
    firstRequest.payload.tools.some((t) => t.name === "schedule_return");

  // The way the connector tools were offered is what the recording decided.
  const recordedCatalog = recorded.find((e) => e.type === "tool_catalog");

  const deps: LoopDeps = {
    store,
    provider,
    tools,
    executor: new NoMachine(recorded),
    bot: options.bot,
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(judge === undefined ? {} : { watchdog: { judge } }),
    ...(loadRunContext === undefined ? {} : { loadRunContext }),
    // A run recorded without approvals is replayed without them (nothing was gated then).
    gate: gated ? createReplayGate(recorded) : allowAllGate(),
    ...(hadVault
      ? {
          // Nothing is resolved in a replay: tools never run, and the log holds placeholders only.
          secrets: {
            redactor: noRedaction,
            resolve: async () => ({}),
          },
        }
      : {}),
    ...(recordedCatalog?.type === "tool_catalog"
      ? { toolSearch: { replayOf: recordedCatalog.payload } }
      : {}),
    ...(hadReturns ? { allowReturns: true } : {}),
    now: clock,
    sleep: async () => {},
  };

  for (;;) {
    const before = appended;
    let status: RunStatus;
    try {
      status = await runLoop(deps, run.id);
    } catch (error) {
      if (error instanceof ReplayHalt) break;
      throw error;
    }
    // The recording continues after a pause (an answer was delivered): run the loop again, its
    // next look at the inbox finds the recorded delivery. If nothing moved, the replay is stuck
    // and the comparison below reports where.
    if (status === "waiting_user" && appended < recorded.length && appended > before) continue;
    if (status === "waiting_timer" && appended < recorded.length) {
      const next = recorded[appended];
      if (next?.type === "wait_fired") {
        // What the job that wakes runs does: the event, then the run is claimable and claimed.
        await store.appendEvent(run.id, { type: next.type, payload: next.payload });
        await memory.setStatus(run.id, { from: ["waiting_timer"], to: "running" });
        continue;
      }
      // Otherwise the user wrote or stopped the run: the loop finds it where the recording did.
      if (appended > before) continue;
    }
    if (status === "waiting_approval" && appended < recorded.length && appended > before) {
      // The decision was made by the user, outside the loop: the store is handed back as a worker
      // would claim it, and the loop finds the recorded decision.
      await memory.setStatus(run.id, { from: ["waiting_approval"], to: "running" });
      continue;
    }
    break;
  }

  const replayedStored = await memory.listEvents(run.id);
  const replayed = replayedStored.map(comparable);
  const recordedComparable = recorded.map(comparable);
  const replayedStatus = (await memory.getRun(run.id)).status;
  const recordedStatus = lastStatus(recorded);

  let divergence = firstDivergence(recordedComparable, replayed);
  if (control.halted !== undefined) {
    const at = replayed.length;
    if (divergence === undefined || divergence.index >= at) {
      divergence = {
        index: at,
        recorded: recordedComparable[at],
        replayed: undefined,
        reason: control.halted,
      };
    }
  }
  const limit = divergence?.index ?? Number.POSITIVE_INFINITY;
  const requestDiffs = diffRequests(recorded, replayedStored, limit);

  const finalStatus = { recorded: recordedStatus, replayed: replayedStatus };
  return {
    identical: divergence === undefined && (recordedStatus ?? initialStatus) === replayedStatus,
    ...(divergence === undefined ? {} : { firstDivergence: divergence }),
    requestDiffs,
    finalStatus,
    ...(control.halted === undefined ? {} : { stoppedBecause: control.halted }),
    replayedEvents: replayed,
  };
}

// ---------------------------------------------------------------------------------------------
// The store of a replay

/**
 * Wraps the in-memory store: the inbox is derived from the recording (what the recording
 * delivered next is what is waiting), the lease is a no-op, and once the replay is stopped every
 * write fails, so the loop leaves nothing behind that the recording does not justify.
 */
class ReplayStore implements RunStore {
  readonly #inner: InMemoryRunStore;
  readonly #recorded: readonly RecordedEvent[];
  readonly #control: { halted: string | undefined };
  readonly #position: () => number;
  readonly #advance: () => void;

  constructor(
    inner: InMemoryRunStore,
    recorded: readonly RecordedEvent[],
    control: { halted: string | undefined },
    position: () => number,
    advance: () => void,
  ) {
    this.#inner = inner;
    this.#recorded = recorded;
    this.#control = control;
    this.#position = position;
    this.#advance = advance;
  }

  #guard(): void {
    if (this.#control.halted !== undefined) throw new ReplayHalt(this.#control.halted);
  }

  getRun(runId: string) {
    return this.#inner.getRun(runId);
  }
  listEvents(runId: string) {
    return this.#inner.listEvents(runId);
  }
  async appendEvent(runId: string, event: RunEventData) {
    this.#guard();
    const result = await this.#inner.appendEvent(runId, event);
    this.#advance();
    return result;
  }
  async setStatus(runId: string, change: StatusChange) {
    this.#guard();
    return this.#inner.setStatus(runId, change);
  }
  async updatePlan(runId: string, plan: PlanStep[]) {
    this.#guard();
    return this.#inner.updatePlan(runId, plan);
  }
  async addUsage(runId: string, usage: UsageDelta) {
    this.#guard();
    return this.#inner.addUsage(runId, usage);
  }
  async ackInbox(): Promise<void> {}
  async ackApprovalDecisions(): Promise<void> {}
  async heartbeat(): Promise<void> {
    this.#guard();
  }

  /** The decisions the recording recorded at this very position of the log. */
  async peekApprovalDecisions(): Promise<ApprovalDecisionItem[]> {
    const items: ApprovalDecisionItem[] = [];
    for (let i = this.#position(); ; i++) {
      const event = this.#recorded[i];
      if (event?.type === "approval_stale") {
        // The late-approval note that follows its decision: the numbers are the recorded ones.
        const item = items.find((it) => it.approvalId === event.payload.approvalId);
        if (item !== undefined) {
          item.stale = {
            waitedMs: event.payload.waitedMs,
            thresholdMs: event.payload.thresholdMs,
          };
        }
        continue;
      }
      if (event?.type !== "approval_decided") break;
      const p = event.payload;
      items.push({
        approvalId: p.approvalId,
        callId: p.callId,
        decision: p.decision,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        ...(p.ruleId === undefined ? {} : { ruleId: p.ruleId }),
      });
    }
    return items;
  }

  /** The items the recording delivered at this very position of the log, with their ids. */
  async peekInbox(): Promise<InboxItem[]> {
    let at = this.#position();
    // The loop logs that the pending return is cancelled just before it delivers what was said.
    if (this.#recorded[at]?.type === "wait_cancelled") at += 1;
    const next = this.#recorded[at];
    if (next === undefined) return [];

    if (next.type === "user_message" && next.payload.inboxId !== undefined) {
      const items: InboxItem[] = [];
      let i = at;
      for (;;) {
        const e = this.#recorded[i];
        if (e?.type !== "user_message" || e.payload.inboxId === undefined) break;
        items.push({ id: e.payload.inboxId, kind: "user_message", text: e.payload.text });
        i += 1;
      }
      items.push(...stopsOf(this.#recorded[i]));
      return items;
    }
    if (
      (next.type === "tool_result" || next.type === "progress_decided") &&
      (next.payload.inboxIds?.length ?? 0) > 0
    ) {
      const ids = next.payload.inboxIds ?? [];
      // The loop joined the messages with a blank line. Splitting there and giving the last item
      // whatever remains reproduces the recorded text exactly, whatever the messages contained.
      const text = next.type === "tool_result" ? next.payload.content : next.payload.text;
      const parts = text.split("\n\n");
      return ids.map((id, n) => ({
        id,
        kind: "user_message" as const,
        text: n < ids.length - 1 ? (parts[n] ?? "") : parts.slice(n).join("\n\n"),
      }));
    }
    return stopsOf(next);
  }
}

function stopsOf(event: RecordedEvent | undefined): InboxItem[] {
  if (event?.type !== "status_changed" || event.payload.to !== "cancelled") return [];
  return (event.payload.inboxIds ?? []).map((id) => ({ id, kind: "stop" as const }));
}

// ---------------------------------------------------------------------------------------------
// Comparison

function comparable(event: RecordedEvent | { type: string; payload: unknown }): ComparableEvent {
  const payload = { ...(event.payload as Record<string, unknown>) };
  delete payload.durationMs;
  // The estimate of a response's input derives from the request, which is compared on its own.
  delete payload.measure;
  // The instant a return was scheduled for is the wall clock of the original run plus the minutes:
  // like a duration, a replay cannot reproduce it (the minutes and the note are compared).
  if (event.type === "wait_scheduled") delete payload.at;
  if (event.type === "model_request") {
    // The request is compared on its own (`requestDiffs`): here only that it was made, and what
    // for.
    return { type: "model_request", payload: { purpose: payload.purpose ?? "agent" } };
  }
  return { type: event.type as RunEventData["type"], payload };
}

function firstDivergence(
  recorded: readonly ComparableEvent[],
  replayed: readonly ComparableEvent[],
): Divergence | undefined {
  const length = Math.max(recorded.length, replayed.length);
  for (let i = 0; i < length; i++) {
    const a = recorded[i];
    const b = replayed[i];
    if (a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b)) continue;
    const changedFields =
      a !== undefined && b !== undefined && a.type === b.type
        ? [...new Set([...Object.keys(a.payload), ...Object.keys(b.payload)])].filter(
            (key) => canonicalJson(a.payload[key]) !== canonicalJson(b.payload[key]),
          )
        : undefined;
    return {
      index: i,
      recorded: a,
      replayed: b,
      ...(changedFields === undefined ? {} : { changedFields }),
    };
  }
  return undefined;
}

function lastStatus(events: readonly RecordedEvent[]): RunStatus | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "status_changed") return e.payload.to;
  }
  return null;
}

const REQUEST_FIELDS = [
  "provider",
  "model",
  "system",
  "messages",
  "tools",
  "hostedToolSearch",
  "toolChoice",
  "maxOutputTokens",
  "temperature",
] as const;

function diffRequests(
  recorded: readonly RecordedEvent[],
  replayed: readonly { type: string; payload: unknown }[],
  limit: number,
): RequestDiff[] {
  const recordedRequests = recorded.flatMap((event, index) =>
    event.type === "model_request" && index < limit ? [{ index, payload: event.payload }] : [],
  );
  const replayedRequests = replayed.flatMap((event) =>
    event.type === "model_request"
      ? [event.payload as Extract<RunEventData, { type: "model_request" }>["payload"]]
      : [],
  );
  const out: RequestDiff[] = [];
  recordedRequests.forEach(({ index, payload: before }, n) => {
    const after = replayedRequests[n];
    if (after === undefined) return;
    const changes: RequestChange[] = [];
    for (const field of REQUEST_FIELDS) {
      const a = before[field];
      const b = after[field];
      if (canonicalJson(a) === canonicalJson(b)) continue;
      const change: RequestChange = { field, recorded: a, replayed: b };
      if (field === "messages") {
        const ma = before.messages;
        const mb = after.messages;
        let at = 0;
        while (
          at < Math.min(ma.length, mb.length) &&
          canonicalJson(ma[at]) === canonicalJson(mb[at])
        ) {
          at += 1;
        }
        change.firstMessage = at;
      }
      changes.push(change);
    }
    if (changes.length > 0) {
      out.push({ index, purpose: before.purpose ?? "agent", changes });
    }
  });
  return out;
}
