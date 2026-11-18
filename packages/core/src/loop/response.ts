// Owns acting on a recorded model response: refusals, text-only turns (final answer for a simple
// question, nudges for truncation, empty output or stopping with open steps, and the no-progress
// guard), and handing tool calls over to execution.

import { EMPTY_RESPONSE_NUDGE, stoppedWithOpenStepsNudge, TRUNCATED_NUDGE } from "./prompts.js";
import { end, fail, nudge } from "./recording.js";
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
  } else if (!state.hasPlan) {
    // A simple question: the text is the answer.
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
