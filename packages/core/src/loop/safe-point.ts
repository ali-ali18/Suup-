// Owns the checks made at the safe point (every result recorded, no model call in flight) that
// can end or pause the run: acting on decisions the log already holds and the cost/duration
// limits. The step limit and the loop guards are the progress watchdog's (watchdog.ts).
import { deliverApprovalDecisions } from "./approval-flow.js";
import { end, fail, record, transition } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";
import { effectiveMaxTurns, endByOwner } from "./watchdog.js";

/** Consecutive turns without a tool call (other than a rejected finish) before the owner is asked. */
export const MAX_NO_PROGRESS_TURNS = 3;
/** The same call with the same result this many times in a row triggers a nudge. */
export const REPEAT_NUDGE_AT = 3;
/** ... and this many asks the owner (or stops a routine). */
export const REPEAT_FAIL_AT = 5;

/**
 * Acts on decisions the log already holds but the store does not reflect yet. `"again"` means a
 * decision of the user arrived just now: the call it concerns is worked on before anything else.
 */
export async function settle(ctx: LoopContext): Promise<RunStatus | "again" | undefined> {
  const state = ctx.state;
  if (state.failedFinish !== null) {
    // A routine's finish that could not be verified: nobody can decide live, so it ends here.
    if (state.wait !== null) {
      await record(ctx, { type: "wait_cancelled", payload: { reason: "finished" } });
    }
    return fail(ctx, state.failedFinish.origin, state.failedFinish.detail);
  }
  if (state.watch.stopRequested) {
    // The owner chose "Parar por aqui" on the watchdog's card: the run ends cleanly, not as an error.
    return endByOwner(ctx);
  }
  if (state.acceptedFinish !== null) {
    // A return still pending is moot now that the work is finished.
    if (state.wait !== null) {
      await record(ctx, { type: "wait_cancelled", payload: { reason: "finished" } });
    }
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

/** The failure detail when a limit is hit, otherwise `undefined` (a technical text for the log). */
export function checkLimits(ctx: LoopContext): string | undefined {
  const run = ctx.run;
  const maxTurns = effectiveMaxTurns(ctx);
  if (run.turns >= maxTurns) {
    return `turn limit reached: ${run.turns} of ${maxTurns} model calls used`;
  }
  return hardLimit(ctx)?.technical;
}

/**
 * The limits the owner configured for cost and time: they end the run (the step limit does not:
 * the watchdog decides what to do about it). `detail` is the sentence the owner reads.
 */
export function hardLimit(ctx: LoopContext): { technical: string; detail: string } | undefined {
  const { limits } = ctx.deps.bot;
  const run = ctx.run;
  if (limits.maxCostUsd !== undefined && run.costUsd >= limits.maxCostUsd) {
    return {
      technical: `cost limit reached: $${run.costUsd.toFixed(4)} spent of $${limits.maxCostUsd} allowed`,
      detail: `Parei porque o gasto desta tarefa chegou ao limite que você configurou (US$ ${run.costUsd.toFixed(2)} de US$ ${limits.maxCostUsd}).`,
    };
  }
  if (limits.maxDurationMs !== undefined) {
    // The time parked for a return is not work: it does not count against the duration limit.
    const elapsed = ctx.deps.now().getTime() - run.startedAt.getTime() - ctx.state.waitedMs;
    if (elapsed >= limits.maxDurationMs) {
      return {
        technical: `duration limit reached: ${Math.round(elapsed / 1000)}s elapsed of ${Math.round(limits.maxDurationMs / 1000)}s allowed`,
        detail: `Parei porque a tarefa passou do tempo máximo que você configurou (${Math.round(elapsed / 1000)} s de ${Math.round(limits.maxDurationMs / 1000)} s).`,
      };
    }
  }
  return undefined;
}
