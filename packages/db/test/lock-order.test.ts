import { describe, expect, it } from "vitest";
import {
  appendMessage,
  createBot,
  createDirectConversation,
  getRun,
  listMessages,
  PgRunStore,
  sendConversationMessage,
  withTransaction,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// The run's status and the bot's message are written in one transaction (`onStatusSet`), which
// touches the conversation. Sending a message locks the conversation and then the run it posts to.
// Both must take the locks in the same order (conversation, then run), or a user answering just
// as the run parks deadlocks one of them (Postgres aborts it with 40P01).

describe.skipIf(!DATABASE_URL)(dbSuiteName("lock order: conversation before run"), () => {
  const ctx = useIsolatedDb();

  it("a send holding the conversation and then touching the run does not deadlock with the run parking", async () => {
    const bot = await createBot(ctx.db, {
      name: `b${Math.random()}`,
      modelProvider: "f",
      modelId: "m",
    });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const sent = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "Faça a tarefa.",
    });
    const runId = sent.run.id;
    const worker = "worker-lock-order";
    await ctx.db.sql`
      update runs set status = 'running', locked_by = ${worker}, locked_at = now() where id = ${runId}`;
    const store = new PgRunStore(ctx.db, {
      workerId: worker,
      onStatusSet: async (tx, run) => {
        await appendMessage(tx, {
          conversationId: conversation.id,
          authorKind: "bot",
          authorBotId: bot.id,
          text: "Qual ambiente?",
          runId: run.id,
          dedupeKey: `run:${run.id}:lock-order`,
        });
      },
    });

    // The "send": holds the conversation row, lets the run try to park, then touches the run row.
    let release: () => void = () => {};
    const holding = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const conversationLocked = new Promise<void>((r) => {
      locked = r;
    });
    const send = withTransaction(ctx.db, async (tx) => {
      await tx.sql`select id from conversations where id = ${conversation.id} for no key update`;
      locked();
      await holding;
      await tx.sql`update runs set updated_at = now() where id = ${runId}`;
    });
    await conversationLocked;
    const park = store.setStatus(runId, { from: ["running"], to: "waiting_user" });
    // Give the park time to take whatever lock it takes first, then let the send go on.
    await new Promise((r) => setTimeout(r, 300));
    release();

    await expect(send).resolves.toBeUndefined();
    await expect(park).resolves.toBe(true);
    expect((await getRun(ctx.db, runId))?.status).toBe("waiting_user");
    const texts = (await listMessages(ctx.db, conversation.id, { limit: 10 })).map((m) => m.text);
    expect(texts).toEqual(["Faça a tarefa.", "Qual ambiente?"]);
  });
});
