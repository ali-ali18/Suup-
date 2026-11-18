import { z } from "zod";
import type { Db } from "./client.js";
import { RunNotFoundError } from "./events.js";

/** What can be posted to a run while it works. */
export type InboxPost = { kind: "user_message"; text: string } | { kind: "stop" };

/** A posted item as stored. `id` is the identity column rendered as a string (it is a bigint). */
export type InboxEntry = InboxPost & { id: string; createdAt: Date };

interface InboxRow {
  id: string;
  kind: "user_message" | "stop";
  text: string | null;
  created_at: Date;
}

function mapEntry(row: InboxRow): InboxEntry {
  const base = { id: String(row.id), createdAt: row.created_at };
  if (row.kind === "user_message") return { ...base, kind: "user_message", text: row.text ?? "" };
  return { ...base, kind: "stop" };
}

const postSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_message"), text: z.string() }),
  z.object({ kind: z.literal("stop") }),
]);

export type PostInboxResult = InboxEntry & {
  /** The run was waiting for the user and was put back in the queue so a worker resumes it. */
  requeued: boolean;
};

/**
 * Posts an item to a run's inbox, in one transaction with the run row locked.
 *
 * A run in `waiting_user` is put back in the queue in the same transaction (`status = 'queued'`,
 * lease cleared): the item is the answer (or the stop) it was waiting for, and a worker claims it
 * like any other queued run. `runLoop` then finds the run `running` while its log says it was
 * waiting, applies the logged status and takes the item from the inbox (the same path it uses to
 * recover from a crash). Nothing changes for any other status: a running run reads the item at
 * its next safe point, a run waiting for approval is not approved by a message, and a finished
 * run keeps the item unread (the caller should start a new run instead).
 *
 * Throws `RunNotFoundError` for an unknown run.
 */
export async function postInbox(db: Db, runId: string, item: InboxPost): Promise<PostInboxResult> {
  const post = postSchema.parse(item);
  return db.sql.begin(async (tx) => {
    const [run] = await tx<{ status: string }[]>`
      select status from runs where id = ${runId} for no key update`;
    if (run === undefined) throw new RunNotFoundError(runId);
    const [row] = await tx<InboxRow[]>`
      insert into run_inbox (run_id, kind, text)
      values (${runId}, ${post.kind}, ${post.kind === "user_message" ? post.text : null})
      returning id, kind, text, created_at`;
    if (row === undefined) throw new Error("insert into run_inbox returned no row");
    const requeued = run.status === "waiting_user";
    if (requeued) {
      await tx`
        update runs set status = 'queued', locked_by = null, locked_at = null
        where id = ${runId} and status = 'waiting_user'`;
    }
    return { ...mapEntry(row), requeued };
  });
}

/** Items not consumed yet, in the order they were posted. Does not consume them. */
export async function peekInboxEntries(db: Db, runId: string): Promise<InboxEntry[]> {
  const rows = await db.sql<InboxRow[]>`
    select id, kind, text, created_at from run_inbox
    where run_id = ${runId} and consumed_at is null
    order by id`;
  return rows.map(mapEntry);
}

/**
 * Marks items as consumed. Idempotent: items already consumed, belonging to another run or not
 * existing are left alone. Returns how many were consumed by this call.
 */
export async function ackInboxEntries(
  db: Db,
  runId: string,
  ids: readonly string[],
): Promise<number> {
  const parsed = z.array(z.string().regex(/^\d+$/)).parse(ids);
  if (parsed.length === 0) return 0;
  const rows = await db.sql`
    update run_inbox set consumed_at = now()
    where run_id = ${runId} and consumed_at is null and id = any(${parsed}::bigint[])
    returning id`;
  return rows.length;
}

/** Whether the run has items nobody consumed yet. */
export async function hasPendingInbox(db: Db, runId: string): Promise<boolean> {
  const [row] = await db.sql<{ pending: boolean }[]>`
    select exists (select 1 from run_inbox where run_id = ${runId} and consumed_at is null) as pending`;
  return row?.pending === true;
}
