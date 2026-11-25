// Owns executing the tool calls of a response: dispatching control tools (plan, finish, escalate)
// versus registry tools, the heartbeat and hard-interruption check between calls, and the
// "interrupted" results that keep the conversation valid after an abort or a crash mid-call.
import type { JsonValue } from "../messages.js";
import type { ToolInvocation } from "../registry.js";
import type { ToolContext } from "../tool.js";
import {
  askGate,
  type CallClearance,
  clearanceFromLog,
  grantFor,
  SKIPPED_AFTER_DENIAL,
} from "./approval-flow.js";
import { handleEscalate, handlePlan, handleScheduleReturn } from "./control-calls.js";
import { handleFinish } from "./finish.js";
import { type ControlCall, ensureToolCall, INTERRUPTED_RESULT, recordResult } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import { handleRequestSecret } from "./secret-request.js";
import type { PendingResponse } from "./state.js";
import type { RunStatus } from "./store.js";
import { USE_TOOL_NAME } from "./tool-search.js";
import { handleSearchTools, resolveUseTool } from "./tool-search-calls.js";
import { webUrlsSeen } from "./web-seen.js";

/** What the model wrote in a turn, besides its calls: its text blocks, in order. */
const turnText = (pending: PendingResponse): string =>
  pending.blocks
    .flatMap((b) => (b.type === "text" && b.text.trim() !== "" ? [b.text.trim()] : []))
    .join("\n\n");

export async function executeCalls(
  ctx: LoopContext,
  pending: PendingResponse,
): Promise<RunStatus | undefined> {
  const alone = pending.toolCalls.length === 1;
  // A `finish` after nothing but `plan` updates in its turn (marking the last step done, then
  // finishing) is judged on its own: the plans run first, in order, and change nothing outside the
  // run. Any other call in the turn, or a plan after the finish, still makes it "not alone".
  const finishAlone = (id: string): boolean => {
    const at = pending.toolCalls.findIndex((c) => c.id === id);
    return pending.toolCalls.every((c, i) => i === at || (c.name === "plan" && i < at));
  };
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
        await handleFinish(ctx, call, finishAlone(call.id));
        break;
      case "escalate":
        await handleEscalate(ctx, call, alone, turnText(pending));
        break;
      case "request_secret":
        await handleRequestSecret(ctx, call, alone);
        break;
      case "schedule_return":
        await handleScheduleReturn(ctx, call);
        break;
      case "search_tools":
        await handleSearchTools(ctx, call);
        break;
      case USE_TOOL_NAME: {
        const resolved = await resolveUseTool(ctx, call);
        if (resolved.kind === "refused") break;
        // From here on it is the real tool: its name, its arguments, its card, its result.
        const waits = await handleTool(ctx, resolved.call, open.started, resolved.schema);
        if (waits) return undefined;
        break;
      }
      default: {
        if (ctx.state.toolCatalog?.mode === "meta" && isDeferred(ctx, call.name)) {
          // Listed in the index but not loaded: it is reached only through `use_tool`.
          await ensureToolCall(ctx, call);
          await recordResult(ctx, call.id, {
            outcome: "unknown_tool",
            isError: true,
            content: `Tool "${call.name}" is not loaded: call it with ${USE_TOOL_NAME} (tool and arguments), after getting its definition with search_tools.`,
          });
          break;
        }
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

function isDeferred(ctx: LoopContext, name: string): boolean {
  return ctx.state.toolCatalog?.deferred.some((d) => d.name === name) === true;
}

/**
 * Runs one registry tool call. Returns `true` when the call waits for the user's decision.
 * `schema` is set when the call came through `use_tool`: a call whose arguments do not validate
 * then gets the real input schema back, since the model never saw it as a tool definition.
 */
async function handleTool(
  ctx: LoopContext,
  call: ControlCall,
  started: boolean,
  schema?: string,
): Promise<boolean> {
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
  // A secret goes only where the user declared, whatever any rule, mode or approval would say: the
  // call is refused before the gate, so no card asks for something that can never run.
  if (logged === undefined && ctx.deps.secrets !== undefined) {
    const refusal = await tools.refuseSecretDestination?.(call.name, call.args, ctx.deps.secrets);
    if (refusal !== undefined) {
      await deny(ctx, call, refusal);
      return false;
    }
  }
  // A call identical to one the user approved too late: the gate still speaks first (deny wins),
  // and the grant only replaces the card it would have asked for.
  const grant = logged === undefined ? grantFor(ctx, call) : undefined;
  const clearance: CallClearance =
    logged ??
    (grant?.consumed === true
      ? { kind: "run", args: call.args as JsonValue }
      : await askGate(ctx, call, grant));
  if (clearance.kind === "wait") return true;
  if (clearance.kind === "denied") {
    await deny(ctx, call, clearance.text);
    return false;
  }
  await ensureToolCall(ctx, call);
  const memory = ctx.deps.memoryFor?.(ctx.run);
  const network = ctx.deps.networkFor?.(ctx.run);
  const web = ctx.deps.webFor?.(ctx.run);
  const files = ctx.deps.filesFor?.(ctx.run);
  const documents = ctx.deps.documentsFor?.(ctx.run);
  const toolCtx: ToolContext = {
    runId: ctx.runId,
    botId: bot.id,
    executor,
    signal: ctx.toolSignal,
    now: () => now(),
    ...(memory === undefined ? {} : { memory }),
    runFacts: { userMessages: [...ctx.state.userSaid], toolsUsed: [...ctx.state.toolsUsed] },
    webSeen: webUrlsSeen(ctx.state),
    ...(network === undefined ? {} : { network }),
    ...(web === undefined ? {} : { web }),
    ...(files === undefined ? {} : { files }),
    ...(documents === undefined ? {} : { documents }),
    callId: call.id,
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
  const withSchema =
    schema !== undefined && invocation.outcome === "invalid_args"
      ? `${invocation.output.content}\nThe input schema of "${call.name}" (JSON): ${schema}`
      : invocation.output.content;
  await recordResult(ctx, call.id, {
    outcome: invocation.outcome,
    isError: invocation.output.isError === true,
    content: withSchema,
    truncated: invocation.truncated,
    durationMs: invocation.durationMs,
    ...(invocation.output.webUrls === undefined ? {} : { webUrls: invocation.output.webUrls }),
    ...(invocation.output.urlProvenance === undefined
      ? {}
      : { urlProvenance: invocation.output.urlProvenance }),
    ...(invocation.output.source === undefined ? {} : { source: invocation.output.source }),
    ...(invocation.risk === undefined ? {} : { risk: invocation.risk }),
  });
  return false;
}

/** The call is refused: it is logged (so the log pairs call and result) and never started. */
async function deny(ctx: LoopContext, call: ControlCall, text: string): Promise<void> {
  await ensureToolCall(ctx, call);
  await recordResult(ctx, call.id, { outcome: "denied", isError: true, content: text });
}
