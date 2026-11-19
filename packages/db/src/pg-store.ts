import {
  type InboxItem,
  LeaseLostError,
  type PlanStep,
  parseRunEvent,
  type RunControl,
  type RunRecord,
  type RunStore,
  type StatusChange,
  type StoredEvent,
  type UsageDelta,
} from "@suup/core";
import { type Db, withTransaction } from "./client.js";
import { appendRunEvent, listRunEvents, RunNotFoundError } from "./events.js";
import { ackInboxEntries, hasPendingInbox, type InboxEntry, peekInboxEntries } from "./inbox.js";
import { heartbeatRun } from "./queue.js";
import {
  addRunUsage,
  getRun,
  type SetRunStatusInput,
  setRunStatus,
  updateRunPlan,
} from "./runs.js";
import type { EventPayload, JsonValue, Run } from "./types.js";

export interface PgRunStoreOptions {
  /**
   * The identity this store works under: the `locked_by` the queue gave the run when it claimed
   * it. Every write is fenced by it (see `PgRunStore`).
   */
  workerId: string;
}

const EVENT_PAGE = 1000;

/**
 * `RunStore` on Postgres, for one worker.
 *
 * Fencing: every write (events, status, plan, usage, inbox acknowledgements) first checks, under
 * a row lock and in the same transaction, that the run is still leased to `workerId`, and throws
 * `LeaseLostError` when it is not. So a worker that was presumed dead and whose runs were requeued
 * and taken over can never append to the log or change the status afterwards, even if its model
 * call returns late. Consequently the run must be claimed (`claimNextRun`, or `PgRunQueue`)
 * before a loop runs on it.
 *
 * Reads (`getRun`, `listEvents`, `peekInbox`) are not fenced.
 *
 * Events are validated with core's `parseRunEvent` on the way in and on the way out. When the loop
 * pauses a run for the user (`requeueIfInbox`) while an item is already waiting in its inbox, the
 * run goes back to the queue instead of waiting (see `postInbox` for the other half of this); the
 * loop does not notice, since its log says `waiting_user` either way.
 */
export class PgRunStore implements RunStore {
  readonly workerId: string;
  readonly #db: Db;

  constructor(db: Db, options: PgRunStoreOptions) {
    this.#db = db;
    this.workerId = options.workerId;
  }

  async getRun(runId: string): Promise<RunRecord> {
    const run = await getRun(this.#db, runId);
    if (run === null) throw new RunNotFoundError(runId);
    return toRecord(run);
  }

  async appendEvent(runId: string, event: Parameters<RunStore["appendEvent"]>[1]) {
    const valid = parseRunEvent(event.type, event.payload);
    const stored = await appendRunEvent(
      this.#db,
      runId,
      valid.type,
      valid.payload as unknown as EventPayload,
      { leaseHolder: this.workerId },
    );
    return { seq: stored.seq };
  }

  async listEvents(runId: string): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await listRunEvents(this.#db, runId, { afterSeq, limit: EVENT_PAGE });
      for (const row of page) {
        const parsed = parseRunEvent(row.type, row.payload);
        out.push({ ...parsed, seq: row.seq, createdAt: row.createdAt });
      }
      const last = page[page.length - 1];
      if (page.length < EVENT_PAGE || last === undefined) return out;
      afterSeq = last.seq;
    }
  }

  async setStatus(runId: string, change: StatusChange): Promise<boolean> {
    return this.#leased(runId, async (tx) => {
      const base = {
        from: change.from,
        ...(change.result === undefined ? {} : { result: change.result as unknown as JsonValue }),
      };
      let input: SetRunStatusInput;
      if (change.to === "failed") {
        if (change.failure === undefined) {
          throw new TypeError("setStatus: `failure` is required when `to` is 'failed'");
        }
        input = { ...base, to: "failed", failure: change.failure };
      } else {
        input = { ...base, to: change.to };
      }
      const updated = await setRunStatus(tx, runId, input);
      if (updated === null) return false;
      if (
        change.requeueIfInbox === true &&
        change.to === "waiting_user" &&
        (await hasPendingInbox(tx, runId))
      ) {
        // Something was posted while the loop was on its way to waiting (the post saw the run
        // `running`, so it did not requeue it): requeue now, or the item would wait for ever.
        await tx.sql`
          update runs set status = 'queued', locked_by = null, locked_at = null
          where id = ${runId} and status = 'waiting_user'`;
      }
      return true;
    });
  }

  async updatePlan(runId: string, plan: PlanStep[]): Promise<void> {
    await this.#leased(runId, (tx) => updateRunPlan(tx, runId, plan));
  }

  async addUsage(runId: string, usage: UsageDelta): Promise<void> {
    await this.#leased(runId, (tx) => addRunUsage(tx, runId, usage));
  }

  async peekInbox(runId: string): Promise<InboxItem[]> {
    return (await peekInboxEntries(this.#db, runId)).map(toItem);
  }

  async ackInbox(runId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#leased(runId, (tx) => ackInboxEntries(tx, runId, ids));
  }

  async heartbeat(runId: string): Promise<RunControl> {
    const control = await heartbeatRun(this.#db, runId, this.workerId);
    if (control === null) throw new LeaseLostError(runId);
    return control;
  }

  /** Runs `fn` in a transaction after checking the lease under the run's row lock. */
  #leased<T>(runId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return withTransaction(this.#db, async (tx) => {
      const [row] = await tx.sql<{ locked_by: string | null }[]>`
        select locked_by from runs where id = ${runId} for no key update`;
      if (row === undefined) throw new RunNotFoundError(runId);
      if (row.locked_by !== this.workerId) throw new LeaseLostError(runId);
      return fn(tx);
    });
  }
}

function toItem(entry: InboxEntry): InboxItem {
  return entry.kind === "user_message"
    ? { id: entry.id, kind: "user_message", text: entry.text }
    : { id: entry.id, kind: "stop" };
}

function toRecord(run: Run): RunRecord {
  return {
    id: run.id,
    botId: run.botId,
    objective: run.objective,
    acceptanceCriteria: run.acceptanceCriteria,
    plan: run.plan,
    status: run.status,
    origin: run.origin,
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: Number(run.costUsd),
    createdAt: run.createdAt,
    // Set when the run is first claimed (or first moved to running); createdAt only for a run
    // that has never started, which the loop does not look at.
    startedAt: run.startedAt ?? run.createdAt,
  };
}
