import { describe, expect, it } from "vitest";
import {
  appendMessage,
  archiveBot,
  createBot,
  createDirectConversation,
  createRun,
  getBotSummary,
  getConversation,
  listBotSummaries,
  listConversations,
  markConversationRead,
  setRunStatus,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("unread counts and the bot list summary"), () => {
  const ctx = useIsolatedDb();

  const newBot = (name: string) =>
    createBot(ctx.db, { name, modelProvider: "p", modelId: "m", allowedTools: [] });

  it("counts bot and system messages after the read mark, never the user's own", async () => {
    const bot = await newBot("u1");
    const conv = await createDirectConversation(ctx.db, bot.id);
    expect(conv).toMatchObject({ unreadCount: 0, lastReadSeq: 0 });

    await appendMessage(ctx.db, { conversationId: conv.id, authorKind: "user", text: "oi" });
    await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "olá",
    });
    await appendMessage(ctx.db, { conversationId: conv.id, authorKind: "system", text: "aviso" });
    expect((await getConversation(ctx.db, conv.id))?.unreadCount).toBe(2);
    expect((await listConversations(ctx.db)).find((c) => c.id === conv.id)?.unreadCount).toBe(2);

    // Reading up to message 2 leaves the system message unread; it never moves backwards.
    expect(await markConversationRead(ctx.db, conv.id, 2)).toMatchObject({
      lastReadSeq: 2,
      unreadCount: 1,
    });
    expect(await markConversationRead(ctx.db, conv.id, 1)).toMatchObject({ lastReadSeq: 2 });
    // Without a number: everything; a number past the end is clamped to the last message.
    expect(await markConversationRead(ctx.db, conv.id)).toMatchObject({
      lastReadSeq: 3,
      unreadCount: 0,
    });
    expect(await markConversationRead(ctx.db, conv.id, 999)).toMatchObject({ lastReadSeq: 3 });
    await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "mais uma",
    });
    expect((await getConversation(ctx.db, conv.id))?.unreadCount).toBe(1);
    expect(await markConversationRead(ctx.db, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("lists bots with the latest run's status and the unread count of their conversation", async () => {
    const quiet = await newBot("quiet");
    const busy = await newBot("busy");
    const gone = await newBot("gone");
    await archiveBot(ctx.db, gone.id);
    const conv = await createDirectConversation(ctx.db, busy.id);
    await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: busy.id,
      text: "pronto",
    });
    const older = await createRun(ctx.db, { botId: busy.id, origin: "user", objective: "antiga" });
    await setRunStatus(ctx.db, older.id, { from: "queued", to: "cancelled" });
    const latest = await createRun(ctx.db, {
      botId: busy.id,
      conversationId: conv.id,
      origin: "user",
      objective: "recente",
    });

    const summaries = await listBotSummaries(ctx.db);
    const byName = new Map(summaries.map((s) => [s.bot.name, s]));
    expect(byName.has("gone")).toBe(false);
    expect(byName.get("quiet")).toMatchObject({
      latestRun: null,
      conversationId: null,
      unreadCount: 0,
    });
    expect(byName.get("busy")).toMatchObject({
      conversationId: conv.id,
      unreadCount: 1,
      latestRun: { id: latest.id, status: "queued", paused: false, objective: "recente" },
    });
    expect(
      (await listBotSummaries(ctx.db, { includeArchived: true })).map((s) => s.bot.name),
    ).toContain("gone");
    expect((await getBotSummary(ctx.db, quiet.id))?.bot.id).toBe(quiet.id);
    expect(await getBotSummary(ctx.db, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});
