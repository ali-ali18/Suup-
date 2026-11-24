// Owns the progress watchdog (docs/VIGIA.md): what happens when a run reaches its step limit or
// starts to repeat itself. Instead of failing, it nudges the model once, extends the run by itself
// when the progress is verifiable (at most twice), and otherwise asks the owner to continue or stop
// (in a routine, where nobody is watching, it stops with a friendly message).
//
// The signals are structural: exact comparison of tool names, canonical arguments, the error flag
// and outcome, and result texts (watch-state.ts). A cheap judge model gives a second opinion near
// the limit; it sees a compact, redacted digest, answers through a schema, and never decides alone
// (its "avanca" extends only when the structural progress shows too).
import { z } from "zod";
import type { ProgressCheck } from "../events.js";
import type { JsonObject } from "../messages.js";
import type { Provider, ToolSpec } from "../provider.js";
import { fingerprint } from "./fingerprint.js";
import { type CallSpec, callModel } from "./model-call.js";
import { loopNudge, repetitionNudge } from "./prompts.js";
import { end, fail, nudge, record, scrub, transition } from "./recording.js";
import type { ModelPricing } from "./reviewer.js";
import { Interrupted, type LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";
import { alternation, errorRun, nearRepeat, progressShown, type WatchCall } from "./watch-state.js";
import {
  askLead,
  continueLabel,
  ownerStoppedText,
  PROGRESS_JUDGE_SYSTEM,
  PROGRESS_JUDGE_TOOL,
  PROGRESS_JUDGE_TOOL_DESCRIPTION,
  type ProgressCause,
  progressQuestion,
  routineStoppedText,
  STOP_LABEL,
  summaryLine,
} from "./watchdog-text.js";

/** The cheap model that gives the second opinion (configured like the reviewer). */
export interface ProgressJudge {
  provider: Provider;
  model: {
    id: string;
    maxOutputTokens: number;
    pricing?: ModelPricing;
    supportsForcedToolChoice?: boolean;
  };
}

export interface WatchdogConfig {
  /** Off: the run fails at its limits and at a loop, as it did before the watchdog existed. */
  enabled: boolean;
  /** Steps one extension grants (the automatic ones and the owner's "Continuar"). */
  extension: number;
  /** How many times the run extends itself before it always asks. */
  maxAutoExtensions: number;
  /** The share of the current slice of steps at which the soft check runs. */
  softLimit: number;
  /** The same call with the same result, in a row: nudge at, ask at. */
  repeatNudgeAt: number;
  repeatAskAt: number;
  /** The same tool failing the same way, in a row: nudge at, ask at. */
  errorNudgeAt: number;
  errorAskAt: number;
  /** Turns in a row without a tool call: ask at (the turns before it are nudged one by one). */
  noToolAskAt: number;
  /** An A-B-A-B run of calls: ask at this length (the nudge comes at 6). */
  alternationAskAt: number;
  judge?: ProgressJudge;
}

export const DEFAULT_WATCHDOG: Omit<WatchdogConfig, "judge"> = {
  enabled: true,
  extension: 25,
  maxAutoExtensions: 2,
  softLimit: 0.8,
  repeatNudgeAt: 3,
  repeatAskAt: 5,
  errorNudgeAt: 3,
  errorAskAt: 5,
  noToolAskAt: 3,
  alternationAskAt: 10,
};

export function resolveWatchdog(config: Partial<WatchdogConfig> | undefined): WatchdogConfig {
  return { ...DEFAULT_WATCHDOG, ...config };
}

type Trigger = ProgressCheck["trigger"];
type Signals = ProgressCheck["signals"];
type Verdict = NonNullable<ProgressCheck["verdict"]>;

export function totalGranted(ctx: LoopContext): number {
  return ctx.state.watch.grants.reduce((sum, n) => sum + n, 0);
}

/** The step limit now: `maxTurns` plus what was granted. */
export function effectiveMaxTurns(ctx: LoopContext): number {
  return ctx.deps.bot.limits.maxTurns + totalGranted(ctx);
}

export function signalsOf(ctx: LoopContext): Signals {
  const { watch, repeat, noProgressStreak } = ctx.state;
  return {
    exactRepeat: repeat.count,
    nearRepeat: nearRepeat(watch),
    errorRun: errorRun(watch),
    noToolTurns: noProgressStreak,
    alternation: alternation(watch),
    changes: watch.totals.changes,
    newCalls: watch.totals.newCalls,
    newEvidence: watch.totals.newEvidence,
  };
}

/** Which pattern keeps going after its nudge, if any: the run must stop and ask. */
function persistingCause(cfg: WatchdogConfig, signals: Signals): ProgressCause | undefined {
  if (signals.exactRepeat >= cfg.repeatAskAt) return "repeat";
  if (signals.errorRun >= cfg.errorAskAt) return "error_loop";
  if (signals.alternation >= cfg.alternationAskAt) return "alternation";
  return undefined;
}

/**
 * A pattern that already earns a nudge. The near-repeat signal is left out on purpose: polling for
 * a result looks like it, so it only goes to the judge (and decides nothing when there is none).
 */
function loopSuspected(cfg: WatchdogConfig, signals: Signals): boolean {
  return (
    signals.exactRepeat >= cfg.repeatNudgeAt ||
    signals.errorRun >= cfg.errorNudgeAt ||
    signals.alternation > 0
  );
}

async function check(
  ctx: LoopContext,
  trigger: Trigger,
  signals: Signals,
  rest: Pick<ProgressCheck, "action"> &
    Partial<Pick<ProgressCheck, "verdict" | "reason" | "judged" | "extension">>,
): Promise<void> {
  await record(ctx, {
    type: "progress_check",
    payload: {
      trigger,
      signals,
      progress: progressShown(ctx.state.watch),
      judged: rest.judged ?? false,
      action: rest.action,
      ...(rest.verdict === undefined ? {} : { verdict: rest.verdict }),
      ...(rest.reason === undefined ? {} : { reason: rest.reason }),
      ...(rest.extension === undefined ? {} : { extension: rest.extension }),
      turns: ctx.run.turns,
      limit: effectiveMaxTurns(ctx),
    },
  });
}

/**
 * The safe-point check of the watchdog, before every model call. `undefined`: go on. A status: the
 * run paused (asked the owner) or ended (a routine stopped), and the loop returns it.
 */
export async function watchdog(ctx: LoopContext): Promise<RunStatus | undefined> {
  const cfg = resolveWatchdog(ctx.deps.watchdog);
  const { state } = ctx;
  const limit = effectiveMaxTurns(ctx);
  const turns = ctx.run.turns;
  if (!cfg.enabled) return legacy(ctx, cfg, limit, turns);

  const signals = signalsOf(ctx);
  if (state.noProgressStreak >= cfg.noToolAskAt)
    return halt(ctx, cfg, "no_tool", "no_tool", signals);
  const persisting = persistingCause(cfg, signals);
  if (persisting !== undefined) {
    const trigger = persisting === "repeat" ? "repeat" : persisting;
    return halt(ctx, cfg, persisting, trigger as Trigger, signals);
  }
  if (turns >= limit) return atLimit(ctx, cfg, signals);

  // A pattern seen for the first time: the model is told once, and may change approach.
  if (signals.exactRepeat >= cfg.repeatNudgeAt && !state.repeat.nudged) {
    await check(ctx, "repeat", signals, { action: "nudge" });
    await nudge(ctx, "repetition", repetitionNudge(state.repeat.name, signals.exactRepeat));
    return undefined;
  }
  if (signals.errorRun >= cfg.errorNudgeAt && !state.watch.nudged.has("error_loop")) {
    const tail = state.watch.recent[state.watch.recent.length - 1] as WatchCall;
    await check(ctx, "error_loop", signals, { action: "nudge" });
    await nudge(ctx, "error_loop", loopNudge("error_loop", tail.name));
    return undefined;
  }
  if (signals.alternation > 0 && !state.watch.nudged.has("alternation")) {
    const [a, b] = state.watch.recent.slice(-2) as [WatchCall, WatchCall];
    await check(ctx, "alternation", signals, { action: "nudge" });
    await nudge(ctx, "alternation", loopNudge("alternation", `${a.name} and ${b.name}`));
    return undefined;
  }

  const slice = sliceBounds(ctx);
  const soft = slice.start + Math.ceil(cfg.softLimit * (limit - slice.start));
  if (turns >= soft && state.watch.softAt !== limit) return softCheck(ctx, cfg, signals);
  return undefined;
}

/** Where the current slice of steps starts (0, or the limit before the last grant). */
function sliceBounds(ctx: LoopContext): { start: number } {
  const grants = ctx.state.watch.grants;
  const last = grants[grants.length - 1];
  return { start: last === undefined ? 0 : effectiveMaxTurns(ctx) - last };
}

/** The soft limit: a look at the run while there are still steps left to change course. */
async function softCheck(
  ctx: LoopContext,
  cfg: WatchdogConfig,
  signals: Signals,
): Promise<undefined> {
  const judged = await judge(ctx, cfg, signals);
  const circling =
    judged === undefined ? loopSuspected(cfg, signals) : judged.verdict === "circulo";
  if (circling && !ctx.state.watch.nudged.has("stuck")) {
    await check(ctx, "soft_limit", signals, { action: "nudge", ...judgedFields(judged) });
    await nudge(
      ctx,
      "stuck",
      loopNudge(
        "stuck",
        judged?.reason !== undefined && judged.reason !== ""
          ? judged.reason
          : "the same calls keep coming back",
      ),
    );
    return undefined;
  }
  await check(ctx, "soft_limit", signals, { action: "continue", ...judgedFields(judged) });
  return undefined;
}

/** The step limit. Extend by itself when the progress is verifiable; otherwise ask, or stop. */
async function atLimit(
  ctx: LoopContext,
  cfg: WatchdogConfig,
  signals: Signals,
): Promise<RunStatus | undefined> {
  const { watch } = ctx.state;
  const progress = progressShown(watch);
  // The judge is only asked when its answer could change something: the run may still extend.
  const canAuto = watch.autoExtensions < cfg.maxAutoExtensions;
  const judged = canAuto && progress ? await judge(ctx, cfg, signals) : undefined;
  // No judge configured (or none asked): the structural signals decide alone.
  const agrees =
    judged === undefined
      ? cfg.judge === undefined && !loopSuspected(cfg, signals)
      : judged.verdict === "avanca" && signals.exactRepeat < cfg.repeatNudgeAt;
  if (canAuto && progress && agrees) {
    await check(ctx, "limit", signals, {
      action: "extend",
      extension: cfg.extension,
      ...judgedFields(judged),
    });
    return undefined;
  }
  return halt(ctx, cfg, "limit", "limit", signals, judged);
}

/** Stop and ask the owner; in a routine nobody is there, so the run ends with a friendly message. */
async function halt(
  ctx: LoopContext,
  cfg: WatchdogConfig,
  cause: ProgressCause,
  trigger: Trigger,
  signals: Signals,
  judged?: Judged,
): Promise<RunStatus> {
  const summary = summaryLine(ctx.state.plan, ctx.state.toolLog.length);
  if (ctx.run.origin === "routine") {
    await check(ctx, trigger, signals, { action: "stop", ...judgedFields(judged) });
    return fail(ctx, "limit", routineStoppedText(cause, summary));
  }
  await check(ctx, trigger, signals, { action: "ask", ...judgedFields(judged) });
  await record(ctx, {
    type: "escalated",
    payload: {
      question: progressQuestion(cfg.extension),
      questions: [
        {
          question: progressQuestion(cfg.extension),
          options: [{ label: continueLabel(cfg.extension) }, { label: STOP_LABEL }],
        },
      ],
      lead: askLead(cause, summary),
      reason: "progress_limit",
      progress: { cause, grant: cfg.extension },
    },
  });
  const ok = await transition(ctx, "running", "waiting_user", { requeueIfInbox: true });
  return ok ? "waiting_user" : (await ctx.deps.store.getRun(ctx.runId)).status;
}

/** The owner chose to stop: the run ends cleanly, with a friendly closing message. */
export function endByOwner(ctx: LoopContext): Promise<RunStatus> {
  const summary = summaryLine(ctx.state.plan, ctx.state.toolLog.length);
  return end(ctx, "done", { result: { summary: ownerStoppedText(summary) } });
}

/** With the watchdog off: the limits and the loops fail the run, as before. */
async function legacy(
  ctx: LoopContext,
  cfg: WatchdogConfig,
  limit: number,
  turns: number,
): Promise<RunStatus | undefined> {
  const { noProgressStreak, repeat } = ctx.state;
  if (turns >= limit) {
    return fail(ctx, "limit", `Parei porque a tarefa chegou ao limite de ${limit} passos.`);
  }
  if (noProgressStreak >= cfg.noToolAskAt) {
    return fail(
      ctx,
      "model",
      `the model made ${noProgressStreak} consecutive turns without a tool call other than a rejected finish, instead of working or finishing properly`,
    );
  }
  if (repeat.count >= cfg.repeatAskAt) {
    return fail(
      ctx,
      "model",
      `the model repeated the same "${repeat.name}" call with identical arguments and an identical result ${repeat.count} times in a row`,
    );
  }
  if (repeat.count >= cfg.repeatNudgeAt && !repeat.nudged) {
    await nudge(ctx, "repetition", repetitionNudge(repeat.name, repeat.count));
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The judge

interface Judged {
  verdict: Verdict;
  reason: string;
}

const judgedFields = (
  judged: Judged | undefined,
): { judged: boolean; verdict?: Verdict; reason?: string } =>
  judged === undefined
    ? { judged: false }
    : { judged: true, verdict: judged.verdict, reason: judged.reason };

const judgeAnswerSchema = z.object({
  verdict: z.enum(["avanca", "circulo", "incerto"]),
  reason: z.string(),
});

const REASON_MAX = 200;
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

function judgeSpec(): ToolSpec {
  const json = z.toJSONSchema(judgeAnswerSchema, {
    io: "input",
    unrepresentable: "any",
  }) as JsonObject;
  const { $schema: _ignored, ...inputSchema } = json;
  return { name: PROGRESS_JUDGE_TOOL, description: PROGRESS_JUDGE_TOOL_DESCRIPTION, inputSchema };
}

/** Result digest sizes: the start and the end of a result, never more. */
const DIGEST_EDGE = 100;
const DIGEST_CALLS = 10;

/**
 * The compact digest the judge sees. Everything in it comes from the log, which is already scrubbed
 * of the vault's values, and it is scrubbed once more on the way out. No arguments (only their
 * fingerprint), no whole results, no history, no vault.
 */
export function judgeDigest(ctx: LoopContext, signals: Signals): string {
  const { state } = ctx;
  const limit = effectiveMaxTurns(ctx);
  const criteria = ctx.run.acceptanceCriteria.map((c, i) => `${i + 1}. ${clip(c, 160)}`).join("\n");
  const plan =
    state.plan.length === 0
      ? "(no plan)"
      : state.plan.map((s) => `- [${s.status}] ${clip(s.title, 100)}`).join("\n");
  const calls = state.watch.recent.slice(-DIGEST_CALLS).map((c, i) => {
    const status = c.isError ? `${c.outcome}, error` : c.outcome;
    const shown =
      c.content.length <= DIGEST_EDGE * 2
        ? `result: ${JSON.stringify(c.content)}`
        : `start: ${JSON.stringify(c.content.slice(0, DIGEST_EDGE))} end: ${JSON.stringify(c.content.slice(-DIGEST_EDGE))}`;
    return `${i + 1}. ${c.name} args#${fingerprint(c.args).slice(0, 8)} -> ${status} (${c.content.length} chars) ${shown}`;
  });
  const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
  const lastText = (lastAssistant?.blocks ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
    .join(" ");
  const text = [
    `## Objective\n${clip(ctx.run.objective, 500)}`,
    `## Acceptance criteria\n${criteria === "" ? "(none)" : clip(criteria, 500)}`,
    `## Plan\n${plan}`,
    `## Counters (measured by the harness)\n${[
      `- steps used: ${ctx.run.turns} of ${limit}`,
      `- changes made (new successful calls that are not reads): ${signals.changes}`,
      `- new successful calls: ${signals.newCalls}`,
      `- new results never seen before: ${signals.newEvidence}`,
      `- turns in a row without a tool call: ${signals.noToolTurns}`,
      `- the same call with the same result, in a row: ${signals.exactRepeat}`,
      `- most times one call (same arguments, any result) appears in the last 8: ${signals.nearRepeat}`,
      `- the same tool failing the same way, in a row: ${signals.errorRun}`,
      `- length of the back-and-forth run of two calls: ${signals.alternation}`,
    ].join("\n")}`,
    `## The last calls (oldest first)\n${calls.length === 0 ? "(none)" : calls.join("\n")}`,
    `## The last thing the assistant said\n${lastText === "" ? "(nothing)" : clip(lastText, 300)}`,
  ].join("\n\n");
  return scrub(ctx, text);
}

/**
 * Asks the judge (when one is configured). Its answer is only a second opinion: a reply that does
 * not fit the schema, or a failure of the call, counts as "incerto". The call costs money (it goes
 * into the run's cost) but is not a step.
 */
async function judge(
  ctx: LoopContext,
  cfg: WatchdogConfig,
  signals: Signals,
): Promise<Judged | undefined> {
  const configured = cfg.judge;
  if (configured === undefined) return undefined;
  const forced = configured.model.supportsForcedToolChoice !== false;
  const spec: CallSpec = {
    purpose: "progress",
    provider: configured.provider,
    model: configured.model,
    system: PROGRESS_JUDGE_SYSTEM,
    messages: [{ role: "user", blocks: [{ type: "text", text: judgeDigest(ctx, signals) }] }],
    tools: [judgeSpec()],
    ...(forced ? { toolChoice: { name: PROGRESS_JUDGE_TOOL } } : {}),
    retries: 0,
  };
  let outcome = await callModel(ctx, spec);
  if (forced && outcome.kind === "error" && outcome.error.kind === "invalid_request") {
    const { toolChoice: _forced, ...unforced } = spec;
    outcome = await callModel(ctx, unforced);
  }
  if (outcome.kind === "aborted") throw new Interrupted();
  if (outcome.kind === "error") return { verdict: "incerto", reason: "o juiz não respondeu" };
  const call = outcome.result.blocks.find(
    (b) => b.type === "tool_call" && b.name === PROGRESS_JUDGE_TOOL,
  );
  if (call === undefined || call.type !== "tool_call") {
    return { verdict: "incerto", reason: "o juiz respondeu fora do formato" };
  }
  const parsed = judgeAnswerSchema.safeParse(call.args);
  if (!parsed.success) return { verdict: "incerto", reason: "o juiz respondeu fora do formato" };
  return { verdict: parsed.data.verdict, reason: clip(parsed.data.reason.trim(), REASON_MAX) };
}

/**
 * The model answered with text alone for the third turn in a row (`reason` says what the harness
 * had asked of it each time): the owner is asked whether to go on, or a routine stops.
 */
export async function stopForNoTool(ctx: LoopContext, reason: string): Promise<RunStatus> {
  const cfg = resolveWatchdog(ctx.deps.watchdog);
  const streak = ctx.state.noProgressStreak + 1;
  if (!cfg.enabled) {
    return fail(
      ctx,
      "model",
      `the model made ${streak} consecutive turns without any tool call (${reason}) instead of working or calling finish`,
    );
  }
  return halt(ctx, cfg, "no_tool", "no_tool", { ...signalsOf(ctx), noToolTurns: streak });
}

/** How many turns in a row without a tool call the run tolerates before it asks. */
export function noToolLimit(ctx: LoopContext): number {
  return resolveWatchdog(ctx.deps.watchdog).noToolAskAt;
}
