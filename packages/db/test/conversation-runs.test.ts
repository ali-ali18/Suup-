import { describe, expect, it } from "vitest";
import {
  addJournalMemory,
  appendMessage,
  appendMessageOnce,
  appendRunEvent,
  archiveBot,
  archiveConversation,
  ConversationSendError,
  createBot,
  createDirectConversation,
  createGroupConversation,
  createRun,
  getActiveConversationRun,
  getMessage,
  listMessages,
  sendConversationMessage,
  setRunStatus,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("conversation runs, delivery and dedupe"), () => {
  const ctx = useIsolatedDb();

  const setup = async () => {
    const bot = await createBot(ctx.db, {
      name: `b${Math.random()}`,
      modelProvider: "f",
      modelId: "m",
    });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    return { bot, conversation };
  };

  it("opens a run for the first message, linked to it", async () => {
    const { bot, conversation } = await setup();
    const sent = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "Olá!",
    });
    expect(sent.queuedForRun).toBe(false);
    expect(sent.run).toMatchObject({
      botId: bot.id,
      conversationId: conversation.id,
      origin: "user",
      objective: "Olá!",
      acceptanceCriteria: [],
      status: "queued",
    });
    expect(sent.message).toMatchObject({ authorKind: "user", runId: sent.run.id, status: null });
    expect((await getActiveConversationRun(ctx.db, conversation.id))?.id).toBe(sent.run.id);
  });

  it("puts a message sent while the run is active in its inbox: sent, then delivered when the loop reads it", async () => {
    const { conversation } = await setup();
    const first = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "um",
    });
    await ctx.db
      .sql`update runs set status = 'running', locked_by = 'w1', locked_at = now() where id = ${first.run.id}`;

    const second = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "dois",
    });
    expect(second.queuedForRun).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.message).toMatchObject({ status: "sent", runId: first.run.id });

    const [item] = await ctx.db.sql<{ id: string; message_id: string }[]>`
      select id, message_id from run_inbox where run_id = ${first.run.id}`;
    expect(item?.message_id).toBe(second.message.id);

    // The loop records the delivering event: the message becomes delivered, atomically with it.
    await appendRunEvent(ctx.db, first.run.id, "user_message", {
      text: "dois",
      inboxId: item?.id ?? "",
    });
    expect((await getMessage(ctx.db, second.message.id))?.status).toBe("delivered");
  });

  it("a message while the run waits for the user is its answer: the run is requeued, and the answer's delivery marks it delivered", async () => {
    const { conversation } = await setup();
    const first = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "um",
    });
    await ctx.db.sql`update runs set status = 'waiting_user' where id = ${first.run.id}`;
    const answer = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "azul",
    });
    expect(answer.queuedForRun).toBe(true);
    expect(answer.run.status).toBe("queued");
    const [item] = await ctx.db.sql<
      { id: string }[]
    >`select id from run_inbox where run_id = ${first.run.id}`;
    await appendRunEvent(ctx.db, first.run.id, "tool_result", {
      callId: "c",
      outcome: "ok",
      content: "azul",
      isError: false,
      truncated: false,
      durationMs: 0,
      inboxIds: [item?.id ?? ""],
    });
    expect((await getMessage(ctx.db, answer.message.id))?.status).toBe("delivered");
  });

  it("a message while the run waits for approval is appended and posted, nothing more", async () => {
    const { conversation } = await setup();
    const first = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "um",
    });
    await ctx.db.sql`update runs set status = 'waiting_approval' where id = ${first.run.id}`;
    const sent = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "ok, pode",
    });
    expect(sent.queuedForRun).toBe(true);
    expect(sent.run.status).toBe("waiting_approval");
  });

  it("opens a new run once the previous one is finished", async () => {
    const { conversation } = await setup();
    const first = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "um",
    });
    await setRunStatus(ctx.db, first.run.id, {
      from: "queued",
      to: "done",
      result: { summary: "ok" },
    });
    const next = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "dois",
    });
    expect(next.queuedForRun).toBe(false);
    expect(next.run.id).not.toBe(first.run.id);
  });

  it("two messages racing produce one run and one inbox item", async () => {
    const { conversation } = await setup();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sendConversationMessage(ctx.db, { conversationId: conversation.id, text: `msg ${i}` }),
      ),
    );
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(results.filter((r) => !r.queuedForRun)).toHaveLength(1);
    const runs = await ctx.db.sql<{ n: string }[]>`
      select count(*) as n from runs where conversation_id = ${conversation.id}`;
    expect(runs[0]?.n).toBe("1");
    const inbox = await ctx.db.sql<{ n: string }[]>`
      select count(*) as n from run_inbox where run_id = ${results[0]?.run.id ?? ""}`;
    expect(inbox[0]?.n).toBe("5");
    // Every message is in the conversation, in order, without gaps.
    const messages = await listMessages(ctx.db, conversation.id, { limit: 20 });
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the database itself refuses a second active user run in a conversation", async () => {
    const { bot, conversation } = await setup();
    await createRun(ctx.db, {
      botId: bot.id,
      conversationId: conversation.id,
      origin: "user",
      objective: "a",
    });
    await expect(
      createRun(ctx.db, {
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        objective: "b",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    // Background runs (other origins) and runs without a conversation are not limited.
    await createRun(ctx.db, {
      botId: bot.id,
      conversationId: conversation.id,
      origin: "routine",
      objective: "c",
    });
    await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "d" });
    await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "e" });
  });

  it("refuses groups, archived conversations and archived bots", async () => {
    const { bot, conversation } = await setup();
    const group = await createGroupConversation(ctx.db, { title: "sala", botIds: [bot.id] });
    await expect(
      sendConversationMessage(ctx.db, { conversationId: group.id, text: "oi" }),
    ).rejects.toBeInstanceOf(ConversationSendError);
    await archiveBot(ctx.db, bot.id);
    await expect(
      sendConversationMessage(ctx.db, { conversationId: conversation.id, text: "oi" }),
    ).rejects.toThrow(/archived/);
    await archiveConversation(ctx.db, conversation.id);
    await expect(
      sendConversationMessage(ctx.db, { conversationId: conversation.id, text: "oi" }),
    ).rejects.toThrow(/archived/);
  });

  it("appendMessage with a dedupe key writes once, however many times it is called", async () => {
    const { bot, conversation } = await setup();
    const input = {
      conversationId: conversation.id,
      authorKind: "bot" as const,
      authorBotId: bot.id,
      text: "resposta",
      dedupeKey: "run:x:done",
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => appendMessageOnce(ctx.db, input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect((await appendMessage(ctx.db, { ...input, text: "outro texto" })).text).toBe("resposta");
    expect(await listMessages(ctx.db, conversation.id, { limit: 10 })).toHaveLength(1);
    // Another conversation has its own keys.
    const other = await setup();
    const o = await appendMessageOnce(ctx.db, {
      ...input,
      conversationId: other.conversation.id,
      authorBotId: other.bot.id,
    });
    expect(o.created).toBe(true);
  });

  it("journal entries are written once per run", async () => {
    const { bot, conversation } = await setup();
    const run = await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "x" });
    const first = await addJournalMemory(ctx.db, {
      botId: bot.id,
      text: "fez x",
      sourceRunId: run.id,
      sourceConversationId: conversation.id,
    });
    expect(first).toMatchObject({
      layer: "journal",
      scope: "bot",
      botId: bot.id,
      createdBy: "bot",
      sourceRunId: run.id,
    });
    const second = await addJournalMemory(ctx.db, {
      botId: bot.id,
      text: "fez x de novo",
      sourceRunId: run.id,
    });
    expect(second).toBeNull();
    const rows = await ctx.db.sql<
      { text: string }[]
    >`select text from memories where source_run_id = ${run.id}`;
    expect(rows.map((r) => r.text)).toEqual(["fez x"]);
  });
});
