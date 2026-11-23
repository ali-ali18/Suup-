// Owns the inbox: finding items the log does not deliver yet, recording user messages, and the
// safe-point delivery of what was posted while the run worked (messages, or a request to stop).
import { end, record } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { InboxItem, RunStatus } from "./store.js";

/**
 * Items still in the inbox that the log does not deliver yet. Items the log already delivers
 * (the process died before acknowledging them) are acknowledged here and left out.
 */
export async function freshInbox(ctx: LoopContext): Promise<InboxItem[]> {
  const { store } = ctx.deps;
  const items = await store.peekInbox(ctx.runId);
  const delivered = ctx.state.deliveredInbox;
  const stale = items.filter((i) => delivered.has(i.id));
  if (stale.length > 0) {
    await store.ackInbox(
      ctx.runId,
      stale.map((i) => i.id),
    );
  }
  return items.filter((i) => !delivered.has(i.id));
}

export async function recordUserMessage(ctx: LoopContext, item: InboxItem): Promise<void> {
  if (item.kind !== "user_message") return;
  // Delivered after a denial and before the model's next request: it is about that denial. The
  // order of the log says so; the text is never read.
  const link = ctx.state.denialLink;
  await record(ctx, {
    type: "user_message",
    payload: {
      text: item.text,
      inboxId: item.id,
      ...(link === null ? {} : { linkedApprovalId: link.approvalId }),
      ...(item.routineRef === undefined ? {} : { routineRef: item.routineRef }),
    },
  });
}

/** Delivers what was posted while the run worked: user messages, or a request to stop. */
export async function deliverInbox(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { store } = ctx.deps;
  const items = await freshInbox(ctx);
  if (items.length === 0) return undefined;
  for (const item of items) await recordUserMessage(ctx, item);
  const stops = items.filter((i) => i.kind === "stop");
  if (stops.length > 0) {
    // The cancellation is logged, then the items are acknowledged, then it is applied (it
    // releases the lease, after which no write is allowed).
    return end(ctx, "cancelled", {
      inboxIds: stops.map((i) => i.id),
      ackInboxIds: items.map((i) => i.id),
    });
  }
  // Only now, with the delivering events in the log, may the store forget the items.
  await store.ackInbox(
    ctx.runId,
    items.map((i) => i.id),
  );
  return undefined;
}
