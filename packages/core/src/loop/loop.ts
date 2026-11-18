// Owns the orchestration of one run: the entry point `runLoop`, the safe-point sequence and the
// turn skeleton. Every responsibility it sequences lives in its own module; this file also keeps
// the public surface of the loop (types, constants and helpers) re-exported from one place.
import { compactIfNeeded } from "./compaction.js";
import { deliverInbox } from "./inbox.js";
import { modelTurn } from "./model-turn.js";
import { fail } from "./recording.js";
import { processPending } from "./response.js";
import { startOrResume } from "./resume.js";
import {
  Interrupted,
  type LoopContext,
  type LoopDeps,
  type RunLoopOptions,
} from "./run-context.js";
import { checkGuards, checkLimits, settle } from "./safe-point.js";
import { rebuildState } from "./state.js";
import { LeaseLostError, type RunStatus } from "./store.js";

export { computeCost, MAX_MODEL_RETRIES } from "./model-call.js";
export { INTERRUPTED_RESULT } from "./recording.js";
export type { ModelPricing, ReviewerConfig } from "./reviewer.js";
export type { BotConfig, LoopDeps, RunLoopOptions, ToolInvoker } from "./run-context.js";
export { MAX_NO_PROGRESS_TURNS, REPEAT_FAIL_AT, REPEAT_NUDGE_AT } from "./safe-point.js";

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
  try {
    const state = rebuildState(await deps.store.listEvents(runId));
    const run = await deps.store.getRun(runId);
    const ctx: LoopContext = {
      deps,
      runId,
      signal: opts.signal,
      pauseSignal: opts.pauseSignal,
      toolSignal: opts.signal ?? new AbortController().signal,
      state,
      run,
    };
    const early = await startOrResume(ctx);
    if (early !== undefined) return early;
    return await loop(ctx);
  } catch (error) {
    if (error instanceof Interrupted) return "running";
    // The lease is gone: someone else owns the run now. Nothing more may be written (not even a
    // failure), so the error goes straight to the caller, who drops the run.
    if (error instanceof LeaseLostError) throw error;
    throw error;
  }
}

async function loop(ctx: LoopContext): Promise<RunStatus> {
  const { store } = ctx.deps;
  for (;;) {
    if (ctx.signal?.aborted) return "running";

    // Work left from a response already recorded (this process's, or a dead one's).
    const mid = await processPending(ctx);
    if (mid !== undefined) return mid;

    // ---- safe point: every result is recorded, no model call is in flight ----
    await store.heartbeat(ctx.runId);

    const settled = await settle(ctx);
    if (settled !== undefined) return settled;

    // Soft stop: this is the safe point after a whole turn. Nothing else is started.
    if (ctx.pauseSignal?.aborted) return "running";

    const inbox = await deliverInbox(ctx);
    if (inbox !== undefined) return inbox;

    ctx.run = await store.getRun(ctx.runId);
    const limit = checkLimits(ctx);
    if (limit !== undefined) return fail(ctx, "limit", limit);

    const guard = await checkGuards(ctx);
    if (guard !== undefined) return guard;

    await compactIfNeeded(ctx);

    const turn = await modelTurn(ctx);
    if (turn !== undefined) return turn;
  }
}
