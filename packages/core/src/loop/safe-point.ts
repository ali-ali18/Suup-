// Owns the checks made at the safe point (every result recorded, no model call in flight) that
// can end or pause the run: acting on decisions the log already holds, the turn/cost/duration
// limits, and the no-progress and repetition guards.
import { deliverApprovalDecisions } from "./approval-flow.js";
import { repetitionNudge } from "./prompts.js";
import { end, fail, nudge, transition } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";

/** Consecutive turns without a tool call (other than a rejected finish) before the run fails. */
export const MAX_NO_PROGRESS_TURNS = 3;
/** The same call with the same result this many times in a row triggers a nudge. */
export const REPEAT_NUDGE_AT = 3;
/** ... and this many fails the run. */
export const REPEAT_FAIL_AT = 5;

/**
 * Acts on decisions the log already holds but the store does not reflect yet. `"again"` means a
 * decision of the user arrived just now: the call it concerns is worked on before anything else.
 */
export async function settle(ctx: LoopContext): Promise<RunStatus | "again" | undefined> {
  const state = ctx.state;
  if (state.acceptedFinish !== null) {
    const { summary, evidence } = state.acceptedFinish;
    return end(ctx, "done", { result: { summary, evidence } });
  }
  if (state.waiting?.kind === "approval") {
    // The user may have answered while the loop was getting here: then it does not pause at all.
    if (await deliverApprovalDecisions(ctx)) return "again";
    const ok = await transition(ctx, "running", "waiting_approval", { requeueIfDecided: true });
    return ok ? "waiting_approval" : (await ctx.deps.store.getRun(ctx.runId)).status;
  }
  if (state.waiting !== null) {
    const ok = await transition(ctx, "running", "waiting_user", { requeueIfInbox: true });
    return ok ? "waiting_user" : (await ctx.deps.store.getRun(ctx.runId)).status;
  }
  return undefined;
}

/** The failure detail when a limit is hit, otherwise `undefined`. */
export function checkLimits(ctx: LoopContext): string | undefined {
  const { limits } = ctx.deps.bot;
  const run = ctx.run;
  if (run.turns >= limits.maxTurns) {
    return `turn limit reached: ${run.turns} of ${limits.maxTurns} model calls used`;
  }
  if (limits.maxCostUsd !== undefined && run.costUsd >= limits.maxCostUsd) {
    return `cost limit reached: $${run.costUsd.toFixed(4)} spent of $${limits.maxCostUsd} allowed`;
  }
  if (limits.maxDurationMs !== undefined) {
    const elapsed = ctx.deps.now().getTime() - run.startedAt.getTime();
    if (elapsed >= limits.maxDurationMs) {
      return `duration limit reached: ${Math.round(elapsed / 1000)}s elapsed of ${Math.round(limits.maxDurationMs / 1000)}s allowed`;
    }
  }
  return undefined;
}

export async function checkGuards(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { noProgressStreak, repeat } = ctx.state;
  if (noProgressStreak >= MAX_NO_PROGRESS_TURNS) {
    return fail(
      ctx,
      "model",
      `the model made ${noProgressStreak} consecutive turns without a tool call other than a rejected finish, instead of working or finishing properly`,
    );
  }
  if (repeat.count >= REPEAT_FAIL_AT) {
    return fail(
      ctx,
      "model",
      `the model repeated the same "${repeat.name}" call with identical arguments and an identical result ${repeat.count} times in a row`,
    );
  }
  if (repeat.count >= REPEAT_NUDGE_AT && !repeat.nudged) {
    await nudge(ctx, "repetition", repetitionNudge(repeat.name, repeat.count));
  }
  return undefined;
}
