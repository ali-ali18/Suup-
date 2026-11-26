import { z } from "zod";
import type { Db } from "./client.js";

export const CHANGE_KINDS = [
  "run_event",
  "run",
  "message",
  "memory",
  "conversation",
  "bot",
  "approval",
  "task",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * One row of the change log (migration 0006): what changed, never the content. The server turns
 * it into a stream event by reading the row it points at.
 */
export interface Change {
  /** Increases in the order the transactions became visible (see the migration). */
  id: number;
  kind: ChangeKind;
  /** The main id: the run for `run_event`, otherwise the id of the row itself. */
  ref: string;
  /** `run_event`: the `seq` of the event. `message`: the `seq` of the message. */
  seq: number | null;
  /** `created`, `updated`, and for memories also `archived` and `restored`. */
  op: string;
  createdAt: Date;
}

interface ChangeRow {
  id: string;
  kind: ChangeKind;
  ref: string;
  ref2: string | null;
  op: string;
  created_at: Date;
}

function mapChange(row: ChangeRow): Change {
  return {
    id: Number(row.id),
    kind: row.kind,
    ref: row.ref,
    seq: row.ref2 === null ? null : Number(row.ref2),
    op: row.op,
    createdAt: row.created_at,
  };
}

/** The name of the NOTIFY channel of this database schema (it carries the id of each new change). */
export async function changeChannel(db: Db): Promise<string> {
  const [row] = await db.sql<{ schema: string }[]>`select current_schema() as schema`;
  return `suup_changes_${row?.schema ?? "public"}`;
}

/** The changes after `afterId`, oldest first. */
export async function listChanges(db: Db, afterId: number, limit = 500): Promise<Change[]> {
  const after = z.number().int().nonnegative().parse(afterId);
  const rows = await db.sql<ChangeRow[]>`
    select id, kind, ref, ref2, op, created_at from change_log
    where id > ${after} order by id limit ${z.number().int().positive().parse(limit)}`;
  return rows.map(mapChange);
}

/**
 * The ids the log knows: `newest` is the latest change (or the latest one pruned, when the log is
 * empty) and `prunedThrough` the highest id already thrown away. A client resuming from an id
 * below `prunedThrough` has lost changes; one above `newest` comes from another database.
 */
export async function changeLogBounds(db: Db): Promise<{ newest: number; prunedThrough: number }> {
  const [row] = await db.sql<{ newest: string; pruned: string }[]>`
    select
      greatest(coalesce((select max(id) from change_log), 0), s.pruned_through) as newest,
      s.pruned_through as pruned
    from change_log_state s`;
  return { newest: Number(row?.newest ?? 0), prunedThrough: Number(row?.pruned ?? 0) };
}

/**
 * Throws away the changes older than `olderThanMs` and all but the newest `keepLast`. Returns how
 * many rows were deleted. Safe to call from every server process.
 */
export async function pruneChangeLog(
  db: Db,
  options: { olderThanMs: number; keepLast: number },
): Promise<number> {
  const olderThanMs = z.number().nonnegative().finite().parse(options.olderThanMs);
  const keepLast = z.number().int().nonnegative().parse(options.keepLast);
  const [row] = await db.sql<{ n: string }[]>`
    with doomed as (
      delete from change_log
      where created_at < now() - make_interval(secs => ${olderThanMs / 1000}::double precision)
         or id <= (select coalesce(max(id), 0) from change_log) - ${keepLast}::bigint
      returning id
    ), bump as (
      update change_log_state
        set pruned_through = greatest(pruned_through, coalesce((select max(id) from doomed), 0))
      returning 1
    )
    select (select count(*) from doomed) as n, (select count(*) from bump) as b`;
  return Number(row?.n ?? 0);
}
