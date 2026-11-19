// Owns executing the tool calls of a response: dispatching control tools (plan, finish, escalate)
// versus registry tools, the heartbeat and hard-interruption check between calls, and the
// "interrupted" results that keep the conversation valid after an abort or a crash mid-call.
import type { ToolInvocation } from "../registry.js";
import type { ToolContext } from "../tool.js";
import {
  askGate,
  type CallClearance,
  clearanceFromLog,
  SKIPPED_AFTER_DENIAL,
} from "./approval-flow.js";
import { handleEscalate, handlePlan } from "./control-calls.js";
import { handleFinish } from "./finish.js";
import { type ControlCall, ensureToolCall, INTERRUPTED_RESULT, recordResult } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import { handleRequestSecret } from "./secret-request.js";
import type { PendingResponse } from "./state.js";
import type { RunStatus } from "./store.js";

export async function executeCalls(
  ctx: LoopContext,
  pending: PendingResponse,
): Promise<RunStatus | undefined> {
  const alone = pending.toolCalls.length === 1;
  for (const call of pending.toolCalls) {
    const open = ctx.state.pendingCalls.find((c) => c.id === call.id);
    if (open === undefined) continue; // already has a result
    // The call the run waits for (an answer, a decision) holds back everything after it.
    const waiting = ctx.state.waiting;
    if (waiting !== null && "callId" in waiting && waiting.callId === call.id) return undefined;

    if (ctx.signal?.aborted) {
      await abortRemaining(ctx);
      return "running";
    }
    await ctx.deps.store.heartbeat(ctx.runId);

    // A call of this turn was denied: the rest is held back, so a batch is never half applied.
    if (ctx.state.denied !== null && !open.started) {
      await recordResult(ctx, call.id, {
        outcome: "denied",
        isError: true,
        content: `Tool "${call.name}" ${SKIPPED_AFTER_DENIAL}`,
      });
      continue;
    }

    switch (call.name) {
      case "plan":
        await handlePlan(ctx, call);
        break;
      case "finish":
        await handleFinish(ctx, call, alone);
        break;
      case "escalate":
        await handleEscalate(ctx, call, alone);
        break;
      case "request_secret":
        await handleRequestSecret(ctx, call, alone);
        break;
      default: {
        const waits = await handleTool(ctx, call, open.started);
        if (waits) return undefined;
      }
    }
  }
  return undefined;
}

/** Gives every call that has no result yet an "interrupted" one, keeping the pairing valid. */
async function abortRemaining(ctx: LoopContext): Promise<void> {
  for (const call of [...ctx.state.pendingCalls]) {
    await recordResult(ctx, call.id, {
      outcome: "aborted",
      isError: true,
      content: call.started
        ? `Tool "${call.name}": ${INTERRUPTED_RESULT}.`
        : `Tool "${call.name}" was not run: the run was interrupted before this call started. Check the actual state before repeating the action, if it still applies.`,
    });
  }
}

/** Runs one registry tool call. Returns `true` when the call waits for the user's decision. */
async function handleTool(ctx: LoopContext, call: ControlCall, started: boolean): Promise<boolean> {
  const { tools, bot, executor, now } = ctx.deps;
  const logged = clearanceFromLog(ctx, call);
  if (logged?.kind === "denied") {
    await deny(ctx, call, logged.text);
    return false;
  }
  if (started) {
    // The process died after logging the call and before logging its result: the action may or
    // may not have happened. Say so, and let the model check.
    await recordResult(ctx, call.id, {
      outcome: "aborted",
      isError: true,
      content: `Tool "${call.name}": ${INTERRUPTED_RESULT}.`,
    });
    return false;
  }
  const clearance: CallClearance = logged ?? (await askGate(ctx, call));
  if (clearance.kind === "wait") return true;
  if (clearance.kind === "denied") {
    await deny(ctx, call, clearance.text);
    return false;
  }
  await ensureToolCall(ctx, call);
  const memory = ctx.deps.memoryFor?.(ctx.run);
  const toolCtx: ToolContext = {
    runId: ctx.runId,
    botId: bot.id,
    executor,
    signal: ctx.toolSignal,
    now: () => now(),
    ...(memory === undefined ? {} : { memory }),
  };
  let invocation: ToolInvocation;
  try {
    invocation = await tools.invoke(call.name, clearance.args, toolCtx, {
      allowed: bot.allowedTools,
      callId: call.id,
      ...(ctx.deps.secrets === undefined ? {} : { secrets: ctx.deps.secrets }),
    });
  } catch (error) {
    await recordResult(ctx, call.id, {
      outcome: "crashed",
      isError: true,
      content: `Tool "${call.name}" failed unexpectedly (${error instanceof Error ? error.message : String(error)}). Try a different approach.`,
    });
    return false;
  }
  await recordResult(ctx, call.id, {
    outcome: invocation.outcome,
    isError: invocation.output.isError === true,
    content: invocation.output.content,
    truncated: invocation.truncated,
    durationMs: invocation.durationMs,
  });
  return false;
}

/** The call is refused: it is logged (so the log pairs call and result) and never started. */
async function deny(ctx: LoopContext, call: ControlCall, text: string): Promise<void> {
  await ensureToolCall(ctx, call);
  await recordResult(ctx, call.id, { outcome: "denied", isError: true, content: text });
}
