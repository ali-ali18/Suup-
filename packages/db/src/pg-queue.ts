import type { FailureOrigin, RunQueue } from "@suup/core";
import { expireOverdueApprovals } from "./approvals.js";
import { type Db, withTransaction } from "./client.js";
import { appendRunEvent } from "./events.js";
import { releaseLeasedRun, requeueStaleRuns } from "./queue.js";
import { claimNextRun, claimRun, setRunStatus } from "./runs.js";

/** Claims remembered per queue object; older ones are forgotten (their runs are long finished). */
const MAX_REMEMBERED = 10_000;

/**
 * `RunQueue` (core's worker interface) on Postgres: `claimNextRun` (`FOR UPDATE SKIP LOCKED`),
 * `releaseLeasedRun`, `requeueStaleRuns`.
 *
 * `release` and `fail` act for the worker that claimed the run through this object, and only while
 * that worker still holds the lease: a worker presumed dead cannot give back or fail a run another
 * worker has taken. A run this object never claimed is left alone.
 */
export class PgRunQueue implements RunQueue {
  readonly #db: Db;
  readonly #onlyRunId: string | undefined;
  readonly #claimedBy = new Map<string, string>();

  /** With `onlyRunId`, the queue only ever hands out that one run (when it is queued). */
  constructor(db: Db, options: { onlyRunId?: string } = {}) {
    this.#db = db;
    this.#onlyRunId = options.onlyRunId;
  }

  async claimNext(workerId: string): Promise<{ runId: string } | null> {
    const run =
      this.#onlyRunId === undefined
        ? await claimNextRun(this.#db, workerId)
        : await claimRun(this.#db, this.#onlyRunId, workerId);
    if (run === null) return null;
    this.#claimedBy.delete(run.id);
    this.#claimedBy.set(run.id, workerId);
    if (this.#claimedBy.size > MAX_REMEMBERED) {
      const oldest = this.#claimedBy.keys().next().value;
      if (oldest !== undefined) this.#claimedBy.delete(oldest);
    }
    return { runId: run.id };
  }

  async release(runId: string): Promise<void> {
    const workerId = this.#claimedBy.get(runId);
    if (workerId === undefined) return;
    await releaseLeasedRun(this.#db, runId, workerId);
  }

  async requeueStale(olderThanMs: number): Promise<number> {
    // The same periodic pass lets the cards expire whose configured limit has passed (none does
    // unless the configuration sets a limit: nothing expires silently).
    await expireOverdueApprovals(this.#db);
    return (await requeueStaleRuns(this.#db, { olderThanMs })).length;
  }

  /** Logs `status_changed` to `failed` and applies it, atomically and only under the lease. */
  async fail(runId: string, failure: { origin: FailureOrigin; detail: string }): Promise<void> {
    const workerId = this.#claimedBy.get(runId);
    if (workerId === undefined) return;
    await withTransaction(this.#db, async (tx) => {
      const [row] = await tx.sql<{ status: string; locked_by: string | null }[]>`
        select status, locked_by from runs where id = ${runId} for no key update`;
      if (row === undefined || row.locked_by !== workerId) return;
      if (row.status === "done" || row.status === "failed" || row.status === "cancelled") return;
      await appendRunEvent(
        tx,
        runId,
        "status_changed",
        { from: row.status, to: "failed", failure },
        { leaseHolder: workerId },
      );
      await setRunStatus(tx, runId, {
        from: row.status as "running",
        to: "failed",
        failure,
      });
    });
  }
}
