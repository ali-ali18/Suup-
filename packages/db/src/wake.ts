import { type Db, withTransaction } from "./client.js";
import { appendRunEvent } from "./events.js";

/** What `wakeDueRuns` did to one run. */
export interface WokenRun {
  runId: string;
  /** How late it fired, in milliseconds (a worker that was down fires it once, late). */
  delayMs: number;
}

export interface WakeDueOptions {
  /** The instant "due" is measured against. Default: the database clock (`now()`). */
  now?: Date;
  /** The most runs one call wakes. Default 20: the next pass takes the rest. */
  limit?: number;
  /** Wake only this run (a process that follows a single run, as the CLI does). */
  runId?: string;
}

/**
 * Wakes the runs parked for a return (`waiting_timer`) whose `wake_at` has come: for each one, in
 * ONE transaction, the event `wait_fired` is written and the run is put back in the queue (status
 * `queued`, lease cleared, `wake_at` and the note cleared). A worker then claims it like any
 * other queued run and the loop reads `wait_fired` from the log (docs/RETORNO.md).
 *
 * Safe to run in any number of workers at once, and again after a crash: the rows are taken with
 * `FOR UPDATE SKIP LOCKED`, and a run that was woken is no longer `waiting_timer`, so the return
 * fires exactly once. A return that fell due while nothing was running fires once, late, never in
 * a burst. Returns the runs it woke.
 */
export async function wakeDueRuns(db: Db, options: WakeDueOptions = {}): Promise<WokenRun[]> {
  const limit = options.limit ?? 20;
  return withTransaction(db, async (tx) => {
    const [clock] = await tx.sql<{ t: Date }[]>`select now() as t`;
    const now = options.now ?? (clock as { t: Date }).t;
    const due = await tx.sql<{ id: string; wake_at: Date; wake_note: string | null }[]>`
      select id, wake_at, wake_note from runs
      where status = 'waiting_timer' and wake_at is not null and wake_at <= ${now}
        and ${options.runId === undefined ? tx.sql`true` : tx.sql`id = ${options.runId}`}
      order by wake_at, id
      limit ${limit}
      for update skip locked`;
    const woken: WokenRun[] = [];
    for (const row of due) {
      const delayMs = Math.max(0, now.getTime() - row.wake_at.getTime());
      await appendRunEvent(tx, row.id, "wait_fired", {
        at: row.wake_at.toISOString(),
        note: row.wake_note ?? "",
        delayMs: Math.round(delayMs),
      });
      await tx.sql`
        update runs set status = 'queued', locked_by = null, locked_at = null,
          wake_at = null, wake_note = null
        where id = ${row.id} and status = 'waiting_timer'`;
      woken.push({ runId: row.id, delayMs: Math.round(delayMs) });
    }
    return woken;
  });
}
