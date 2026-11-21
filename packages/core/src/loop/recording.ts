// Owns writing to the run: appending events (and folding them into the in-memory state), status
// transitions (log first, then compare-and-set in the store), failing/ending the working phase,
// nudges, and recording tool calls and results.
import type { RunEventData } from "../events.js";
import type { ToolInvocation } from "../registry.js";
import type { LoopContext } from "./run-context.js";
import { applyEvent } from "./state.js";
import type { FailureOrigin, RunResult, RunStatus, StoredEvent } from "./store.js";

export const INTERRUPTED_RESULT =
  "interrupted — the result is unknown; check the actual state before repeating this action";

export interface TransitionExtra {
  failure?: { origin: FailureOrigin; detail: string };
  result?: RunResult;
  /** Inbox items this change delivers (a cancellation asked for through the inbox). */
  inboxIds?: string[];
  /** Pausing for the user: see `StatusChange.requeueIfInbox`. */
  requeueIfInbox?: boolean;
  /** Pausing for an approval: see `StatusChange.requeueIfDecided`. */
  requeueIfDecided?: boolean;
  /**
   * Inbox items to acknowledge once the change is in the log and before it is applied. A change
   * to a finished status releases the lease, after which the store may no longer be written to,
   * so the acknowledgement has to come in between.
   */
  ackInboxIds?: string[];
  /**
   * Parking for a return (`to: "waiting_timer"`): when, the note, the count, and the bot's message
   * to the user (logged in the status change, where the runtime reads it to write the chat message).
   */
  wake?: { at: string; note: string; count: number; message: string };
  /**
   * The status the STORE has, when it is not the one the log says the run left (a resumed run
   * that was parked and was claimed again is `running` in the store while the log says
   * `waiting_timer`).
   */
  storeFrom?: RunStatus;
}

export interface ControlCall {
  id: string;
  name: string;
  args: unknown;
}

/** `value` with every known secret value scrubbed out (a copy), when the run has a vault. */
export function scrub<T>(ctx: LoopContext, value: T): T {
  const redactor = ctx.deps.secrets?.redactor;
  return redactor === undefined ? value : redactor.redactJson(value);
}

/**
 * Appends the event and folds it into the state. The event is scrubbed of known secret values
 * FIRST, so the log and the conversation the model sees are the same and neither holds a value.
 */
export async function record(ctx: LoopContext, event: RunEventData): Promise<void> {
  const safe = scrub(ctx, event);
  const { seq } = await ctx.deps.store.appendEvent(ctx.runId, safe);
  applyEvent(ctx.state, { ...safe, seq, createdAt: ctx.deps.now() } as StoredEvent);
}

/** Records the status change in the log first, then applies it to the store (compare-and-set). */
export async function transition(
  ctx: LoopContext,
  from: RunStatus,
  to: RunStatus,
  extra: TransitionExtra = {},
): Promise<boolean> {
  extra = {
    ...extra,
    ...(extra.failure === undefined ? {} : { failure: scrub(ctx, extra.failure) }),
    ...(extra.result === undefined ? {} : { result: scrub(ctx, extra.result) }),
  };
  // The log can be ahead of the store: a process that died after logging this very change but
  // before applying it. The change is then only applied, never logged twice.
  if (ctx.state.status !== to) {
    await recordStatus(ctx, from, to, extra);
  }
  if (extra.ackInboxIds !== undefined && extra.ackInboxIds.length > 0) {
    await ctx.deps.store.ackInbox(ctx.runId, extra.ackInboxIds);
  }
  return ctx.deps.store.setStatus(ctx.runId, {
    from: [extra.storeFrom ?? from],
    to,
    ...(extra.wake === undefined
      ? {}
      : { wake: { at: extra.wake.at, note: extra.wake.note, count: extra.wake.count } }),
    ...(extra.failure === undefined ? {} : { failure: extra.failure }),
    ...(extra.result === undefined ? {} : { result: extra.result }),
    ...(extra.requeueIfInbox === true ? { requeueIfInbox: true } : {}),
    ...(extra.requeueIfDecided === true ? { requeueIfDecided: true } : {}),
  });
}

async function recordStatus(
  ctx: LoopContext,
  from: RunStatus,
  to: RunStatus,
  extra: TransitionExtra,
): Promise<void> {
  await record(ctx, {
    type: "status_changed",
    payload: {
      from,
      to,
      ...(extra.failure === undefined ? {} : { failure: extra.failure }),
      ...(extra.result === undefined
        ? extra.wake === undefined
          ? {}
          : { result: { summary: extra.wake.message } }
        : { result: extra.result }),
      ...(extra.inboxIds === undefined ? {} : { inboxIds: extra.inboxIds }),
    },
  });
}

/** Ends the working phase with `to`; returns the status the run really has afterwards. */
export async function end(
  ctx: LoopContext,
  to: RunStatus,
  extra: TransitionExtra = {},
): Promise<RunStatus> {
  const applied = await transition(ctx, "running", to, extra);
  return applied ? to : (await ctx.deps.store.getRun(ctx.runId)).status;
}

export function fail(ctx: LoopContext, origin: FailureOrigin, detail: string): Promise<RunStatus> {
  return end(ctx, "failed", { failure: { origin, detail } });
}

export async function nudge(ctx: LoopContext, reason: string, text: string): Promise<void> {
  await record(ctx, { type: "nudge", payload: { reason, text } });
}

/** Logs the `tool_call` event unless the call was already logged (a resumed run). */
export async function ensureToolCall(ctx: LoopContext, call: ControlCall): Promise<void> {
  const open = ctx.state.pendingCalls.find((c) => c.id === call.id);
  if (open?.started) return;
  await record(ctx, {
    type: "tool_call",
    payload: { callId: call.id, name: call.name, args: call.args as never },
  });
}

export async function recordResult(
  ctx: LoopContext,
  callId: string,
  r: {
    outcome: ToolInvocation["outcome"];
    isError: boolean;
    content: string;
    truncated?: boolean;
    durationMs?: number;
    toolReferences?: string[];
    webUrls?: string[];
    urlProvenance?: "user_message" | "search_result" | "page_link" | "approved";
  },
): Promise<void> {
  await record(ctx, {
    type: "tool_result",
    payload: {
      callId,
      outcome: r.outcome,
      content: r.content,
      isError: r.isError,
      truncated: r.truncated ?? false,
      durationMs: r.durationMs ?? 0,
      ...(r.toolReferences === undefined ? {} : { toolReferences: r.toolReferences }),
      ...(r.webUrls === undefined ? {} : { webUrls: r.webUrls }),
      ...(r.urlProvenance === undefined ? {} : { urlProvenance: r.urlProvenance }),
    },
  });
}
