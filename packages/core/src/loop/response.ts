// Owns acting on a recorded model response: refusals, text-only turns (final answer for a simple
// question, nudges for truncation, empty output or stopping with open steps, and the no-progress
// guard), and handing tool calls over to execution.

import {
  EMPTY_RESPONSE_NUDGE,
  FINISH_REQUIRED_NUDGE,
  stoppedWithOpenStepsNudge,
  TRUNCATED_NUDGE,
} from "./prompts.js";
import { end, fail, nudge, transition } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import { MAX_NO_PROGRESS_TURNS } from "./safe-point.js";
import type { PendingResponse } from "./state.js";
import type { RunStatus } from "./store.js";
import { executeCalls } from "./tool-execution.js";

/** Work left from a response already recorded (this process's, or a dead one's). */
export async function processPending(ctx: LoopContext): Promise<RunStatus | undefined> {
  const pending = ctx.state.pending;
  if (pending === null) return undefined;
  if (pending.stopReason === "refusal") {
    return fail(
      ctx,
      "model",
      `the model refused to continue${textOf(pending) === "" ? "" : `: ${textOf(pending).slice(0, 300)}`}`,
    );
  }
  if (pending.toolCalls.length === 0) return handleTextOnly(ctx, pending);
  return executeCalls(ctx, pending);
}

async function handleTextOnly(
  ctx: LoopContext,
  pending: PendingResponse,
): Promise<RunStatus | undefined> {
  const state = ctx.state;
  const text = textOf(pending);
  let reason: string;
  let nudgeText: string;
  if (pending.stopReason === "max_tokens") {
    reason = "output_truncated";
    nudgeText = TRUNCATED_NUDGE;
  } else if (text === "") {
    reason = "empty_response";
    nudgeText = EMPTY_RESPONSE_NUDGE;
  } else if (state.wait !== null && !state.wait.parked) {
    // The bot scheduled a return and this is its message to the user: the run is parked for it.
    return parkForReturn(ctx, text);
  } else if (!state.hasPlan && ctx.run.acceptanceCriteria.length > 0 && !state.finishRequested) {
    // The run has acceptance criteria: a plain-text reply would skip the evidence and the review.
    // It is sent back ONCE asking for finish; a second plain reply ends the run as before.
    reason = "finish_required";
    nudgeText = FINISH_REQUIRED_NUDGE;
  } else if (!state.hasPlan) {
    // A simple question (or criteria already asked for once): the text is the answer.
    return end(ctx, "done", { result: { summary: text } });
  } else {
    reason = "stopped_without_finish";
    nudgeText = stoppedWithOpenStepsNudge(state.plan);
  }
  if (state.noProgressStreak + 1 >= MAX_NO_PROGRESS_TURNS) {
    return fail(
      ctx,
      "model",
      `the model made ${state.noProgressStreak + 1} consecutive turns without any tool call (${reason}) instead of working or calling finish`,
    );
  }
  await nudge(ctx, reason, nudgeText);
  return undefined;
}

function textOf(pending: PendingResponse): string {
  return pending.blocks
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

/**
 * Settles the run into `waiting_timer`: the turn ended with the bot's message to the user (kept in
 * the status change, which is where the runtime reads the chat message from), and the run waits
 * for the instant it scheduled. Nothing holds a worker meanwhile.
 */
async function parkForReturn(ctx: LoopContext, message: string): Promise<RunStatus> {
  const wait = ctx.state.wait;
  if (wait === null) return (await ctx.deps.store.getRun(ctx.runId)).status;
  const ok = await transition(ctx, "running", "waiting_timer", {
    wake: { at: wait.at, note: wait.note, count: ctx.state.wakeCount, message },
    requeueIfInbox: true,
  });
  return ok ? "waiting_timer" : (await ctx.deps.store.getRun(ctx.runId)).status;
}
