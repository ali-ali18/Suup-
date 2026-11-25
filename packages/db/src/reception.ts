import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ACTIVE_RUN_STATUSES, getActiveConversationRun } from "./conversation-runs.js";
import { type ConversationView, createDirectConversation } from "./conversations.js";
import { createRun } from "./runs.js";
import type { Run } from "./types.js";

/** Active bots whose direct conversation has not yet had its welcome. */
export async function listReceptionCandidates(
  db: Db,
  models: readonly { modelId: string; providerId: string }[],
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  if (models.length === 0) return [];
  const rows = await db.sql<{ id: string }[]>`
    select b.id from bots b
    join jsonb_to_recordset(${db.sql.json([...models])}::jsonb)
      as m("modelId" text, "providerId" text)
      on m."modelId" = b.model_id and m."providerId" = b.model_provider
    left join conversation_members cm on cm.bot_id = b.id and cm.conversation_kind = 'direct'
    left join conversations c on c.id = cm.conversation_id
    where b.archived_at is null and (
      cm.conversation_id is null
      or (c.archived_at is null and c.reception in ('pending', 'redo')
        and not exists (select 1 from runs r where r.conversation_id = c.id
          and r.origin in ('user', 'reception', 'delegation')
          and r.status = any(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])))
    )
    order by case when ${afterId}::uuid is null or b.id > ${afterId}::uuid then 0 else 1 end, b.id
    limit ${limit}`;
  return rows.map((row) => row.id);
}

export interface StartReceptionResult {
  /** The direct conversation of the bot (created if it did not exist). */
  conversationId: string;
  /** The welcome was started by THIS call (its run is `run`). False when it already was, or never will be. */
  started: boolean;
  run: Run | null;
}

/**
 * Starts the welcome of a bot, once. The app calls it when the user opens the chat of a bot; the
 * database decides, under the lock of the conversation row, so the welcome cannot start twice (two
 * app windows, two workers, a crash in the middle: the state and the run are written in ONE
 * transaction, so either both exist or neither).
 *
 * - `pending` and the conversation is empty and has no active run: the run (`origin: "reception"`,
 *   `objective`) is created and the state becomes `started`.
 * - `pending` but the conversation already has messages (or an active run): nothing to welcome, the
 *   state becomes `done`.
 * - `redo`: starts even with a history (the user asked), unless a run is active (then nothing now).
 * - `started` or `done`: nothing.
 *
 * `objective` says what the run is for; it receives whether this is a redo. Throws
 * `ConversationRuleError` for an unknown or archived bot.
 */
export async function startReception(
  db: Db,
  botId: string,
  objective: (redo: boolean) => string,
): Promise<StartReceptionResult> {
  const id = z.uuid().parse(botId);
  const conversation: ConversationView = await createDirectConversation(db, id);
  return withTransaction(db, async (tx) => {
    const [conv] = await tx.sql<{ reception: string }[]>`
      select reception from conversations where id = ${conversation.id} for no key update`;
    const state = conv?.reception;
    if (state !== "pending" && state !== "redo") {
      return { conversationId: conversation.id, started: false, run: null };
    }
    const [any] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from messages where conversation_id = ${conversation.id}`;
    const busy = (await getActiveConversationRun(tx, conversation.id)) !== null;
    if (busy) {
      // A run is working in this chat (the user spoke first): it is not for the welcome to start.
      if (state === "pending") {
        await tx.sql`update conversations set reception = 'done' where id = ${conversation.id}`;
      }
      return { conversationId: conversation.id, started: false, run: null };
    }
    if (state === "pending" && (any?.n ?? 0) > 0) {
      await tx.sql`update conversations set reception = 'done' where id = ${conversation.id}`;
      return { conversationId: conversation.id, started: false, run: null };
    }
    const run = await createRun(tx, {
      botId: id,
      conversationId: conversation.id,
      origin: "reception",
      objective: objective(state === "redo"),
    });
    await tx.sql`update conversations set reception = 'started' where id = ${conversation.id}`;
    return { conversationId: conversation.id, started: true, run };
  });
}

/**
 * "Refazer a recepção": the next open of the bot's chat starts the welcome again (`redo`). Refused
 * (`false`) while a run of the conversation is active, and for a bot that has no conversation yet
 * (its first open is already a welcome). Idempotent.
 */
export async function resetReception(db: Db, botId: string): Promise<boolean> {
  const id = z.uuid().parse(botId);
  return withTransaction(db, async (tx) => {
    const [conv] = await tx.sql<{ id: string; reception: string }[]>`
      select c.id, c.reception from conversations c
      join conversation_members cm on cm.conversation_id = c.id
      where cm.bot_id = ${id} and c.kind = 'direct'
      for no key update of c`;
    if (conv === undefined) return true;
    if (conv.reception === "pending" || conv.reception === "redo") return true;
    const [active] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from runs
      where conversation_id = ${conv.id}
        and origin in ('user', 'reception', 'delegation')
        and status = any(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])`;
    if ((active?.n ?? 0) > 0) return false;
    await tx.sql`update conversations set reception = 'redo' where id = ${conv.id}`;
    return true;
  });
}

/** The welcome run ended (any way): the state is `done`, so it never starts by itself again. */
export async function finishReception(db: Db, conversationId: string): Promise<void> {
  await db.sql`
    update conversations set reception = 'done'
    where id = ${z.uuid().parse(conversationId)} and reception = 'started'`;
}
