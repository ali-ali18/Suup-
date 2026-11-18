import { z } from "zod";
import type { Db } from "./client.js";
import { mapRun, type RunRow } from "./runs.js";
import type { Run } from "./types.js";

/**
 * Renews the lease: `locked_at = now()`, but only while the run is still leased to `workerId`.
 * Returns `false` when it is not (the run finished, was requeued, or another worker has it), which
 * is how a worker learns it lost the run.
 */
export async function renewLease(db: Db, runId: string, workerId: string): Promise<boolean> {
  return (await heartbeatRun(db, runId, workerId)) !== null;
}

/** What the user asked of a run from outside, as the worker holding it reads it. */
export interface RunControlState {
  /** Stop at the next safe point (the user paused the run). */
  pause: boolean;
  /** Stop now: abort the model call and the tool in flight. */
  interrupt: boolean;
}

/**
 * `renewLease`, and it also says what the user asked of the run meanwhile (pause, interrupt), in
 * the same statement: this is how a worker in one process obeys a request made through the server
 * in another. `null` when the run is no longer leased to `workerId`.
 */
export async function heartbeatRun(
  db: Db,
  runId: string,
  workerId: string,
): Promise<RunControlState | null> {
  const [row] = await db.sql<{ pause: boolean; interrupt: boolean }[]>`
    update runs set locked_at = now()
    where id = ${runId} and locked_by = ${workerId}
    returning paused_at is not null as pause, interrupt_requested_at is not null as interrupt`;
  return row === undefined ? null : { pause: row.pause, interrupt: row.interrupt };
}

export interface RequeueStaleOptions {
  /** A running run whose lease was last renewed more than this many milliseconds ago is stale. */
  olderThanMs: number;
}

/**
 * Puts runs whose worker stopped renewing the lease back in the queue (`running` -> `queued`,
 * lease cleared) and returns their ids. Only `running` runs are touched: a run in `waiting_user`
 * or `waiting_approval` is waiting for a person, not for a worker, so it has nothing to expire.
 * `started_at` is kept. Staleness is measured with the database clock.
 */
export async function requeueStaleRuns(db: Db, opts: RequeueStaleOptions): Promise<string[]> {
  const olderThanMs = z.number().nonnegative().finite().parse(opts.olderThanMs);
  const rows = await db.sql<{ id: string }[]>`
    update runs set status = 'queued', locked_by = null, locked_at = null,
      interrupt_requested_at = null
    where status = 'running'
      and locked_at < now() - make_interval(secs => ${olderThanMs / 1000}::double precision)
    returning id`;
  return rows.map((r) => r.id);
}

/**
 * Gives a run back to the queue on behalf of the worker that holds it (graceful shutdown):
 * `running` -> `queued`, lease cleared. Does nothing, and returns `null`, if the run is not
 * running under that worker any more.
 */
export async function releaseLeasedRun(
  db: Db,
  runId: string,
  workerId: string,
): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`
    update runs set status = 'queued', locked_by = null, locked_at = null,
      interrupt_requested_at = null
    where id = ${runId} and locked_by = ${workerId} and status = 'running'
    returning *`;
  return row ? mapRun(row) : null;
}
