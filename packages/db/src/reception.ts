import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ACTIVE_RUN_STATUSES, getActiveConversationRun } from "./conversation-runs.js";
import { type ConversationView, createDirectConversation } from "./conversations.js";
import { createRun } from "./runs.js";
import type { Run } from "./types.js";

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
