import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ConversationNotFoundError, ConversationRuleError } from "./conversations.js";
import { postInbox } from "./inbox.js";
import { appendMessage, type Message } from "./messages.js";
import { createRun, getRun, mapRun, type RunRow } from "./runs.js";
import type { Run } from "./types.js";

/** Statuses of a run that is still the conversation's foreground run (everything but the final ones). */
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_user",
  "waiting_approval",
  "waiting_timer",
] as const;

/** Thrown when the conversation cannot take the message (a group, an archived bot...). */
export class ConversationSendError extends ConversationRuleError {
  override name = "ConversationSendError";
}

export interface SendConversationMessageResult {
  /** The user message as stored. */
  message: Message;
  /** The run that now holds it: the one it opened, or the one that was already working. */
  run: Run;
  /** The message went to a run that was already active, instead of opening a new one. */
  queuedForRun: boolean;
}

/**
 * The foreground run of a conversation: the user-origin run that is not finished, if any. There is
 * at most one (a unique index guarantees it).
 */
export async function getActiveConversationRun(
  db: Db,
  conversationId: string,
): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`
    select * from runs
    where conversation_id = ${z.uuid().parse(conversationId)}
      and origin = 'user'
      and status = any(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])
    order by created_at, id
    limit 1`;
  return row ? mapRun(row) : null;
}

/**
 * Puts a user message into a direct conversation, atomically.
 *
 * - No active run: the message is appended and a run is created for the bot of the conversation
 *   (`origin: "user"`, objective = the text, no acceptance criteria), linked to the message. The
 *   run is `queued`; a worker takes it as usual.
 * - A run is active (queued, running, waiting for the user or for an approval): the message is
 *   appended with status `sent` and posted to that run's inbox. It becomes `delivered` when the
 *   loop records the event that reads it (see `appendRunEvent`). If the run waits for the user,
 *   the message is its answer and the post requeues it; if it waits for an approval, nothing is
 *   approved (the inbox does not approve anything).
 *
 * Everything happens in one transaction that locks the conversation row, so two messages arriving
 * together are serialized: the first opens the run, the second sees it and goes to its inbox. The
 * unique index on active runs per conversation is the last guard; a unique violation (a run
 * created by some other path) is retried once and then resolves to the "active run" branch.
 *
 * Throws `ConversationNotFoundError`, and `ConversationSendError` for an archived conversation, a
 * group (not supported yet) or an archived bot.
 */
export async function sendConversationMessage(
  db: Db,
  input: { conversationId: string; text: string },
): Promise<SendConversationMessageResult> {
  const conversationId = z.uuid().parse(input.conversationId);
  const text = z
    .string()
    .refine((t) => t.trim().length > 0, "text must not be blank")
    .parse(input.text);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(db, (tx) => sendOnce(tx, conversationId, text));
    } catch (error) {
      if (attempt < 3 && (error as { code?: string }).code === "23505") continue;
      throw error;
    }
  }
}

async function sendOnce(
  tx: Db,
  conversationId: string,
  text: string,
): Promise<SendConversationMessageResult> {
  const [conv] = await tx.sql<{ kind: string; archived_at: Date | null }[]>`
    select kind, archived_at from conversations where id = ${conversationId} for no key update`;
  if (!conv) throw new ConversationNotFoundError(conversationId);
  if (conv.archived_at !== null) {
    throw new ConversationSendError("Cannot send messages to an archived conversation");
  }
  if (conv.kind !== "direct") {
    throw new ConversationSendError("Group conversations do not take messages yet");
  }

  const active = await getActiveConversationRun(tx, conversationId);
  if (active !== null) {
    const message = await appendMessage(tx, {
      conversationId,
      authorKind: "user",
      text,
      runId: active.id,
      status: "sent",
    });
    await postInbox(tx, active.id, { kind: "user_message", text, messageId: message.id });
    const run = (await getRun(tx, active.id)) ?? active;
    return { message, run, queuedForRun: true };
  }

  const [member] = await tx.sql<{ bot_id: string; archived_at: Date | null }[]>`
    select cm.bot_id, b.archived_at from conversation_members cm
    join bots b on b.id = cm.bot_id
    where cm.conversation_id = ${conversationId}`;
  if (!member) throw new ConversationSendError("The conversation has no bot");
  if (member.archived_at !== null) {
    throw new ConversationSendError("The bot of this conversation is archived");
  }
  const run = await createRun(tx, {
    botId: member.bot_id,
    conversationId,
    origin: "user",
    objective: text,
  });
  const message = await appendMessage(tx, {
    conversationId,
    authorKind: "user",
    text,
    runId: run.id,
  });
  return { message, run, queuedForRun: false };
}

/**
 * A message posted to a run's inbox that the run never read, because the run ended first (the
 * message arrived while the run was finishing). Such a message must not be lost: it becomes the
 * objective of a new run of the same conversation, created now, under the conversation lock (so
 * no second foreground run can appear at the same time). The messages are re-linked to the new
 * run (they opened it) and marked `delivered`; their inbox items are consumed.
 *
 * Returns the new run, or `null` when there is nothing unread (or the run is not a finished
 * conversation run). Idempotent: a second call finds nothing.
 */
export async function rolloverUnreadMessages(db: Db, runId: string): Promise<Run | null> {
  const id = z.uuid().parse(runId);
  return withTransaction(db, async (tx) => {
    const [run] = await tx.sql<
      { conversation_id: string | null; bot_id: string; status: string }[]
    >`
      select conversation_id, bot_id, status from runs where id = ${id}`;
    if (!run?.conversation_id) return null;
    if (!["done", "failed", "cancelled"].includes(run.status)) return null;
    // The same lock `sendConversationMessage` takes: a message that is still being posted to this
    // run commits before we look, and one that comes later finds no active run.
    await tx.sql`select 1 from conversations where id = ${run.conversation_id} for no key update`;
    const items = await tx.sql<{ id: string; text: string; message_id: string | null }[]>`
      select id, text, message_id from run_inbox
      where run_id = ${id} and kind = 'user_message' and consumed_at is null
      order by id`;
    if (items.length === 0) return null;
    if ((await getActiveConversationRun(tx, run.conversation_id)) !== null) return null;
    const objective = items.map((i) => i.text).join("\n\n");
    const next = await createRun(tx, {
      botId: run.bot_id,
      conversationId: run.conversation_id,
      origin: "user",
      objective,
    });
    const messageIds = items.flatMap((i) => (i.message_id === null ? [] : [i.message_id]));
    if (messageIds.length > 0) {
      await tx.sql`
        update messages set run_id = ${next.id}, status = 'delivered'
        where id = any(${messageIds}::uuid[])`;
    }
    await tx.sql`
      update run_inbox set consumed_at = now()
      where run_id = ${id} and consumed_at is null and id = any(${items.map((i) => i.id)}::bigint[])`;
    return next;
  });
}

/**
 * The foreground run of each of the given conversations, in one query (a list screen needs it for
 * all of them at once). Conversations with no active run are absent from the map.
 */
export async function listActiveConversationRuns(
  db: Db,
  conversationIds: readonly string[],
): Promise<Map<string, Run>> {
  const ids = z.array(z.uuid()).parse([...conversationIds]);
  if (ids.length === 0) return new Map();
  const rows = await db.sql<RunRow[]>`
    select * from runs
    where conversation_id = any(${ids}::uuid[])
      and origin = 'user'
      and status = any(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])`;
  return new Map(rows.map((row) => [row.conversation_id as string, mapRun(row)]));
}
