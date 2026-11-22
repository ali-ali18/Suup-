// Owns starting and resuming a run: the terminal/approval gate, logging `run_started`, reconciling
// a status the log announced but the store never applied, and picking a `waiting_user` run back up
// from the inbox (an answer, extra messages, or a stop).
import { answerForModel } from "../answers.js";
import { escalatedQuestions } from "../events.js";
import { deliverApprovalDecisions } from "./approval-flow.js";
import { freshInbox, recordUserMessage } from "./inbox.js";
import { record, transition } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";
import { planToolSearch } from "./tool-search.js";

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

  await ensureContext(ctx);
  await ensureToolCatalog(ctx);

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

  // The run paused for an approval and its decision made it claimable again (or a crash left the
  // store behind the log): put the store where the log is, then take the decision in.
  if (
    (ctx.run.status === "running" || ctx.run.status === "queued") &&
    ctx.state.status === "waiting_approval"
  ) {
    await store.setStatus(runId, { from: [ctx.run.status], to: "waiting_approval" });
    ctx.run = await store.getRun(runId);
    if (ctx.run.status !== "waiting_approval") return ctx.run.status;
    return resumeFromApproval(ctx);
  }

  // The run was parked for a return it scheduled (the log says so, whatever the store says: it may
  // just have been claimed again after the wake job fired, or after a crash).
  if (
    (ctx.run.status === "running" ||
      ctx.run.status === "queued" ||
      ctx.run.status === "waiting_timer") &&
    ctx.state.status === "waiting_timer"
  ) {
    return resumeFromTimer(ctx);
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
async function resumeFromApproval(ctx: LoopContext): Promise<RunStatus | undefined> {
  await deliverApprovalDecisions(ctx);
  // Still no answer for the call the run waits for: it stays where it is.
  if (ctx.state.waiting?.kind === "approval") return "waiting_approval";
  const ok = await transition(ctx, "waiting_approval", "running");
  return ok ? undefined : (await ctx.deps.store.getRun(ctx.runId)).status;
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
    if (waiting.kind === "escalate" || waiting.kind === "secret") {
      // The answer is the result of the pending escalate (or request_secret) call. For a question
      // the model also reads which question it is, and an option typed by its number or letter is
      // already its label (the one place every surface's answer passes through: `suup say`, the
      // chat of the CLI, the server and the app).
      const typed = messages.map((i) => (i.kind === "user_message" ? i.text : "")).join("\n\n");
      const content =
        waiting.kind === "escalate" ? answerForModel(escalatedQuestions(waiting), typed) : typed;
      await record(ctx, {
        type: "tool_result",
        payload: {
          callId: waiting.callId,
          outcome: "ok",
          content,
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

/**
 * A run parked in `waiting_timer` is looked at again. `undefined` means it is running again and
 * the loop should go on.
 *
 * - The return fired (`wait_fired` is in the log: the wake job wrote it when it made the run
 *   claimable) or was cancelled: the run goes back to `running`; the model reads the note.
 * - The return is still pending, and the user wrote meanwhile: the return is cancelled
 *   (`user_message`), the messages are delivered as usual and the run goes on with them.
 * - Still pending, and a stop is in the inbox: the return is cancelled and so is the run.
 * - Still pending and nothing else: it stays parked (the store is put where the log is).
 */
async function resumeFromTimer(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { store } = ctx.deps;
  const from = ctx.run.status;
  const wait = ctx.state.wait;
  if (wait !== null) {
    const items = await freshInbox(ctx);
    const messages = items.filter((i) => i.kind === "user_message");
    const stops = items.filter((i) => i.kind === "stop");
    if (stops.length > 0) {
      await record(ctx, { type: "wait_cancelled", payload: { reason: "cancelled" } });
      for (const item of messages) await recordUserMessage(ctx, item);
      const ok = await transition(ctx, "waiting_timer", "cancelled", {
        inboxIds: stops.map((i) => i.id),
        ackInboxIds: items.map((i) => i.id),
        storeFrom: from,
      });
      return ok ? "cancelled" : (await store.getRun(ctx.runId)).status;
    }
    if (messages.length === 0) {
      if (from !== "waiting_timer") {
        await store.setStatus(ctx.runId, {
          from: [from],
          to: "waiting_timer",
          wake: { at: wait.at, note: wait.note, count: ctx.state.wakeCount },
          requeueIfInbox: true,
        });
      }
      return "waiting_timer";
    }
    await record(ctx, { type: "wait_cancelled", payload: { reason: "user_message" } });
    for (const item of messages) await recordUserMessage(ctx, item);
    await store.ackInbox(
      ctx.runId,
      messages.map((i) => i.id),
    );
  }
  const ok = await transition(ctx, "waiting_timer", "running", { storeFrom: from });
  return ok ? undefined : (await store.getRun(ctx.runId)).status;
}

/**
 * Loads the run's outside context and records it, once. It is loaded only while nothing but
 * `run_started` is in the log: a run that already went further (a run started before the context
 * existed, or one resumed after the event was written) never loads it, so the conversation and the
 * system prompt cannot change under a run that is under way.
 */
async function ensureContext(ctx: LoopContext): Promise<void> {
  const load = ctx.deps.loadRunContext;
  const { state } = ctx;
  if (load === undefined || state.contextLoaded || state.lastSeq !== state.startSeq) return;
  const snapshot = await load(ctx.runId);
  await record(ctx, {
    type: "context_loaded",
    payload: {
      rules: snapshot.rules,
      profile: snapshot.profile,
      history: snapshot.history,
      ...(snapshot.historyNote === undefined ? {} : { historyNote: snapshot.historyNote }),
      ...(snapshot.secrets === undefined ? {} : { secrets: snapshot.secrets }),
      ...(snapshot.now === undefined ? {} : { now: snapshot.now }),
      ...(snapshot.team === undefined ? {} : { team: snapshot.team }),
      ...(snapshot.machine === undefined ? {} : { machine: snapshot.machine }),
      ...(snapshot.connectors === undefined ? {} : { connectors: snapshot.connectors }),
      ...(snapshot.reception === undefined ? {} : { reception: snapshot.reception }),
      ...(snapshot.supervisor === undefined ? {} : { supervisor: snapshot.supervisor }),
      ...(snapshot.routine === undefined ? {} : { routine: snapshot.routine }),
      ...(snapshot.compactionThreshold === undefined
        ? {}
        : { compactionThreshold: snapshot.compactionThreshold }),
      ...(snapshot.memoryOmitted === undefined ? {} : { memoryOmitted: snapshot.memoryOmitted }),
    },
  });
}

/**
 * Decides, once, how the connector tools of this run reach the model, and records it. Only before
 * the first request of the run: afterwards the tools can no longer change under it (a run that
 * began without the event keeps offering every tool directly).
 */
async function ensureToolCatalog(ctx: LoopContext): Promise<void> {
  const setup = ctx.deps.toolSearch;
  const { state } = ctx;
  if (setup === undefined || state.toolCatalog !== null || state.sawRequest) return;
  if ("replayOf" in setup) {
    await record(ctx, { type: "tool_catalog", payload: structuredClone(setup.replayOf) });
    return;
  }
  if (setup.candidates.length === 0) return;
  const specs = new Map(
    ctx.deps.tools.specs(ctx.deps.bot.allowedTools).map((spec) => [spec.name, spec]),
  );
  await record(ctx, {
    type: "tool_catalog",
    payload: planToolSearch(setup, specs, ctx.deps.provider.capabilities),
  });
}
