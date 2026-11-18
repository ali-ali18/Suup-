// Owns starting and resuming a run: the terminal/approval gate, logging `run_started`, reconciling
// a status the log announced but the store never applied, and picking a `waiting_user` run back up
// from the inbox (an answer, extra messages, or a stop).
import { freshInbox, recordUserMessage } from "./inbox.js";
import { record, transition } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";

/**
 * Brings a freshly loaded run to the point where the loop can start. `undefined` means the run is
 * running and the loop should go on; otherwise the status to return right away.
 */
export async function startOrResume(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { store } = ctx.deps;
  const { runId } = ctx;
  // A previous process may have died between recording an inbox delivery and acknowledging it.
  await freshInbox(ctx);

  const gate = ctx.run.status;
  if (gate === "done" || gate === "failed" || gate === "cancelled" || gate === "waiting_approval") {
    return gate;
  }

  if (!ctx.state.started) {
    await record(ctx, {
      type: "run_started",
      payload: {
        botId: ctx.run.botId,
        objective: ctx.run.objective,
        acceptanceCriteria: ctx.run.acceptanceCriteria,
        origin: ctx.run.origin,
      },
    });
  }

  // The log is the truth. If the process died after logging a status change but before the
  // store applied it, apply it now.
  // The store may also say `queued`: a run that was requeued (a stale lease, or a user's answer
  // posted to a waiting run) and picked up again keeps the status its log last announced.
  const logged = ctx.state.status;
  if (
    (ctx.run.status === "running" || ctx.run.status === "queued") &&
    (logged === "done" ||
      logged === "failed" ||
      logged === "cancelled" ||
      logged === "waiting_user")
  ) {
    const { failure, result } = ctx.state.statusDetail;
    await store.setStatus(runId, {
      from: [ctx.run.status],
      to: logged,
      ...(failure === undefined ? {} : { failure }),
      ...(result === undefined ? {} : { result }),
    });
    ctx.run = await store.getRun(runId);
    if (ctx.run.status !== "waiting_user") return ctx.run.status;
  }

  if (ctx.run.status === "queued") {
    if (!(await transition(ctx, "queued", "running"))) {
      return (await store.getRun(runId)).status;
    }
  } else if (ctx.run.status === "waiting_user") {
    const resumed = await resumeFromWaiting(ctx);
    if (resumed !== undefined) return resumed;
  }
  return undefined;
}

/** `undefined` means the run is running again and the loop should go on. */
async function resumeFromWaiting(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { store } = ctx.deps;
  const waiting = ctx.state.waiting;
  if (waiting !== null) {
    const items = await freshInbox(ctx);
    const messages = items.filter((i) => i.kind === "user_message");
    const stops = items.filter((i) => i.kind === "stop");
    if (stops.length > 0) {
      for (const item of messages) await recordUserMessage(ctx, item);
      const ok = await transition(ctx, "waiting_user", "cancelled", {
        inboxIds: stops.map((i) => i.id),
        ackInboxIds: items.map((i) => i.id),
      });
      return ok ? "cancelled" : (await store.getRun(ctx.runId)).status;
    }
    if (messages.length === 0) return "waiting_user";
    if (waiting.kind === "escalate") {
      // The answer is the result of the pending escalate call.
      await record(ctx, {
        type: "tool_result",
        payload: {
          callId: waiting.callId,
          outcome: "ok",
          content: messages.map((i) => (i.kind === "user_message" ? i.text : "")).join("\n\n"),
          isError: false,
          truncated: false,
          durationMs: 0,
          inboxIds: messages.map((i) => i.id),
        },
      });
    } else {
      for (const item of messages) await recordUserMessage(ctx, item);
    }
    await store.ackInbox(
      ctx.runId,
      messages.map((i) => i.id),
    );
  }
  const ok = await transition(ctx, "waiting_user", "running");
  return ok ? undefined : (await store.getRun(ctx.runId)).status;
}
