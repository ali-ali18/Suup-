import { z } from "zod";
import { cancelPendingApprovals } from "./approvals.js";
import { type Db, withTransaction } from "./client.js";
import { appendRunEvent } from "./events.js";
import { postInbox } from "./inbox.js";
import { mapRun, type RunRow, setRunStatus } from "./runs.js";
import type { Run } from "./types.js";

export type RunControlErrorCode = "not_found" | "finished" | "not_pausable" | "not_paused";

/** What the user asked of a run cannot be done in the state it is in. */
export class RunControlError extends Error {
  override readonly name = "RunControlError";
  constructor(
    readonly code: RunControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

async function lockRun(tx: Db, runId: string): Promise<RunRow> {
  const [row] = await tx.sql<RunRow[]>`
    select * from runs where id = ${z.uuid().parse(runId)} for no key update`;
  if (row === undefined)
    throw new RunControlError("not_found", `Execução ${runId} não encontrada.`);
  return row;
}

/**
 * Pauses a run from outside the worker. Nothing here runs the loop: it only marks the run, and the
 * worker that holds it obeys (the loop stops at its next safe point after the turn in progress);
 * a run no worker holds (still queued) simply stops being claimable. The run stays resumable
 * (`resumeRun`) and its log is not touched.
 *
 * With `hard`, the worker is also asked to stop NOW: it aborts the model call and the tool in
 * flight at its next heartbeat (the interrupted tool gets an "interrupted" result, so the log
 * stays valid for the resume). Idempotent; `hard` on a run that is already paused escalates it.
 *
 * Only a run that is queued or running can be paused. Throws `RunControlError`: `not_found`;
 * `finished` for a run that already ended; `not_pausable` for one that waits for the user or for
 * an approval (it is not using a worker, and the answer is what moves it).
 */
export async function pauseRun(
  db: Db,
  runId: string,
  options: { hard?: boolean } = {},
): Promise<Run> {
  return withTransaction(db, async (tx) => {
    const run = await lockRun(tx, runId);
    if (TERMINAL.has(run.status)) {
      throw new RunControlError("finished", "A execução já terminou e não pode ser pausada.");
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw new RunControlError(
        "not_pausable",
        run.status === "waiting_user"
          ? "A execução está esperando a sua resposta; não há o que pausar."
          : run.status === "waiting_timer"
            ? "A execução está parada até a hora do retorno que ela marcou; não há o que pausar."
            : "A execução está esperando uma aprovação; não há o que pausar.",
      );
    }
    const interrupt = options.hard === true && run.status === "running";
    const [row] = await tx.sql<RunRow[]>`
      update runs set
        paused_at = coalesce(paused_at, now()),
        interrupt_requested_at = case when ${interrupt} then coalesce(interrupt_requested_at, now())
                                      else interrupt_requested_at end
      where id = ${run.id}
      returning *`;
    return mapRun(row as RunRow);
  });
}

/**
 * Undoes `pauseRun`: the run is claimable again (or, if it was still `running` and had not stopped
 * yet, it just goes on). Throws `RunControlError`: `not_found`, `finished`, or `not_paused` when
 * the run is not paused.
 */
export async function resumeRun(db: Db, runId: string): Promise<Run> {
  return withTransaction(db, async (tx) => {
    const run = await lockRun(tx, runId);
    if (TERMINAL.has(run.status)) {
      throw new RunControlError("finished", "A execução já terminou e não pode ser retomada.");
    }
    if (run.paused_at === null) {
      throw new RunControlError("not_paused", "A execução não está pausada.");
    }
    const [row] = await tx.sql<RunRow[]>`
      update runs set paused_at = null, interrupt_requested_at = null
      where id = ${run.id} returning *`;
    return mapRun(row as RunRow);
  });
}

/**
 * Cancels a run from outside the worker: posts the `stop` item to its inbox (the loop applies it
 * at a safe point and the run ends `cancelled`), clears a pause so a worker can take the run to
 * apply it, and, when the run is working right now, also asks for a hard interrupt so it does not
 * go on for a whole turn first. A run waiting for the user is put back in the queue by the post.
 * A run waiting for an approval is cancelled directly (no worker holds it), and so is a run parked
 * for a return of its own (`waiting_timer`; its pending return is cancelled in the log), and so is a run that is
 * still queued and has never started (its log is empty: there is nothing to unwind, and waiting
 * for a worker that may never come would leave it queued forever). A queued run that already has a
 * log (it was requeued after an answer, or a lease expired) still goes through the loop, which
 * closes its log the way the loop always does.
 *
 * Applying it otherwise needs a worker alive. Throws `RunControlError`: `not_found`, `finished`.
 */
export async function cancelRun(db: Db, runId: string): Promise<Run> {
  return withTransaction(db, async (tx) => {
    const run = await lockRun(tx, runId);
    if (TERMINAL.has(run.status)) {
      throw new RunControlError("finished", "A execução já terminou e não pode ser cancelada.");
    }
    if (run.status === "waiting_approval") {
      // The pending cards end with the run; the log says so before the run does.
      for (const card of await cancelPendingApprovals(tx, run.id)) {
        await appendRunEvent(tx, run.id, "approval_decided", {
          approvalId: card.id,
          callId: card.callId,
          decision: "cancelled",
        });
      }
      await appendRunEvent(tx, run.id, "status_changed", {
        from: "waiting_approval",
        to: "cancelled",
      });
      const done = await setRunStatus(tx, run.id, { from: "waiting_approval", to: "cancelled" });
      if (done !== null) return done;
    }
    if (run.status === "waiting_timer") {
      // Parked for a return of its own: nobody holds it, so it ends right here. The return does not
      // fire any more; the log says why, then the run ends.
      await appendRunEvent(tx, run.id, "wait_cancelled", { reason: "cancelled" });
      await appendRunEvent(tx, run.id, "status_changed", {
        from: "waiting_timer",
        to: "cancelled",
      });
      const done = await setRunStatus(tx, run.id, { from: "waiting_timer", to: "cancelled" });
      if (done !== null) return done;
    }
    if (run.status === "queued") {
      const [{ n } = { n: 0 }] = await tx.sql<{ n: number }[]>`
        select count(*)::int as n from run_events where run_id = ${run.id}`;
      if (n === 0) {
        await appendRunEvent(tx, run.id, "status_changed", { from: "queued", to: "cancelled" });
        const done = await setRunStatus(tx, run.id, { from: "queued", to: "cancelled" });
        if (done !== null) return done;
      }
    }
    // A card of this run may already exist while the run is still `running` (the loop logs the
    // request, then parks the run a moment later). Parked with the stop only in its inbox, nobody
    // would ever read it: the card would wait for ever. So the cards end now, as a decision the
    // worker has not recorded yet: the loop reads it, settles the call, then reads the stop.
    await cancelPendingApprovals(tx, run.id, { deliver: false });
    await postInbox(tx, run.id, { kind: "stop" });
    const [row] = await tx.sql<RunRow[]>`
      update runs set
        paused_at = null,
        interrupt_requested_at = case when status = 'running' then coalesce(interrupt_requested_at, now())
                                      else null end
      where id = ${run.id}
      returning *`;
    return mapRun(row as RunRow);
  });
}
