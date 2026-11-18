import { describe, expect, it } from "vitest";
import {
  addMember,
  appendMessage,
  archiveBot,
  archiveConversation,
  type Bot,
  ConversationNotFoundError,
  ConversationRuleError,
  createBot,
  createDirectConversation,
  createGroupConversation,
  createRun,
  getBot,
  getConversation,
  getDefaultBot,
  listConversations,
  listRuns,
  MESSAGE_PREVIEW_LENGTH,
  removeMember,
  setDefaultBot,
  updateBot,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("bots: avatar and default; conversations"), () => {
  const ctx = useIsolatedDb();

  const newBot = (name = "bot", avatar?: string): Promise<Bot> =>
    createBot(ctx.db, {
      name,
      modelProvider: "fake",
      modelId: "fake-1",
      ...(avatar ? { avatar } : {}),
    });
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  describe("bot avatar", () => {
    it("is null by default, set on create and changed or cleared on update", async () => {
      const plain = await newBot("plain");
      expect(plain.avatar).toBeNull();
      expect(plain.isDefault).toBe(false);
      const bot = await newBot("pic", "emoji:🦊");
      expect(bot.avatar).toBe("emoji:🦊");
      expect((await updateBot(ctx.db, bot.id, { avatar: "file:abc" }))?.avatar).toBe("file:abc");
      expect((await updateBot(ctx.db, bot.id, { name: "renamed" }))?.avatar).toBe("file:abc");
      expect((await updateBot(ctx.db, bot.id, { avatar: null }))?.avatar).toBeNull();
      await expect(updateBot(ctx.db, bot.id, { avatar: "" })).rejects.toThrow();
    });
  });

  describe("default bot", () => {
    it("has at most one default; setting another moves it", async () => {
      expect(await getDefaultBot(ctx.db)).toBeNull();
      const a = await newBot("a");
      const b = await newBot("b");
      expect((await setDefaultBot(ctx.db, a.id))?.isDefault).toBe(true);
      expect((await getDefaultBot(ctx.db))?.id).toBe(a.id);
      expect((await setDefaultBot(ctx.db, a.id))?.id).toBe(a.id); // idempotent
      await setDefaultBot(ctx.db, b.id);
      expect((await getDefaultBot(ctx.db))?.id).toBe(b.id);
      expect((await getBot(ctx.db, a.id))?.isDefault).toBe(false);
      const [count] = await ctx.db.sql<{ n: string }[]>`
        select count(*) as n from bots where is_default and archived_at is null`;
      expect(Number(count?.n)).toBe(1);
    });

    it("is refused by the database when two active bots are default", async () => {
      const a = await setDefaultBot(ctx.db, (await newBot("x")).id);
      const other = await newBot("y");
      await expect(
        ctx.db.sql`update bots set is_default = true where id = ${other.id}`,
      ).rejects.toThrow(/bots_one_default_idx/);
      expect(a?.isDefault).toBe(true);
    });

    it("ignores an archived default, and an archived or unknown bot cannot become one", async () => {
      const a = await newBot("old default");
      await setDefaultBot(ctx.db, a.id);
      await archiveBot(ctx.db, a.id);
      expect(await getDefaultBot(ctx.db)).toBeNull();
      const b = await newBot("new default");
      expect((await setDefaultBot(ctx.db, b.id))?.id).toBe(b.id);
      expect(await setDefaultBot(ctx.db, a.id)).toBeNull();
      expect(await setDefaultBot(ctx.db, UNKNOWN)).toBeNull();
      expect((await getDefaultBot(ctx.db))?.id).toBe(b.id);
    });

    it("survives concurrent changes with exactly one winner", async () => {
      const bots = await Promise.all(Array.from({ length: 6 }, (_, i) => newBot(`c${i}`)));
      await Promise.all(bots.map((b) => setDefaultBot(ctx.db, b.id)));
      const [count] = await ctx.db.sql<{ n: string }[]>`
        select count(*) as n from bots where is_default and archived_at is null`;
      expect(Number(count?.n)).toBe(1);
    });
  });

  describe("direct conversations", () => {
    it("creates one per bot, idempotently, also under concurrency", async () => {
      const bot = await newBot("Ana", "emoji:A");
      const first = await createDirectConversation(ctx.db, bot.id);
      expect(first).toMatchObject({
        kind: "direct",
        title: null,
        lastMessageAt: null,
        archivedAt: null,
        lastMessage: null,
      });
      expect(first.members).toHaveLength(1);
      expect(first.members[0]).toMatchObject({ botId: bot.id, name: "Ana", avatar: "emoji:A" });

      const again = await createDirectConversation(ctx.db, bot.id);
      expect(again.id).toBe(first.id);

      const other = await newBot("Bia");
      const racing = await Promise.all(
        Array.from({ length: 8 }, () => createDirectConversation(ctx.db, other.id)),
      );
      expect(new Set(racing.map((c) => c.id)).size).toBe(1);
      expect(await getConversation(ctx.db, first.id)).toEqual(first);
    });

    it("rejects unknown and archived bots, but returns an existing conversation of an archived bot", async () => {
      await expect(createDirectConversation(ctx.db, UNKNOWN)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
      const bot = await newBot("gone");
      await archiveBot(ctx.db, bot.id);
      await expect(createDirectConversation(ctx.db, bot.id)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
      const bot2 = await newBot("leaves");
      const conv = await createDirectConversation(ctx.db, bot2.id);
      await archiveBot(ctx.db, bot2.id);
      expect((await createDirectConversation(ctx.db, bot2.id)).id).toBe(conv.id);
    });

    it("reopens an archived direct conversation instead of making a second one", async () => {
      const bot = await newBot("again");
      const conv = await createDirectConversation(ctx.db, bot.id);
      expect((await archiveConversation(ctx.db, conv.id))?.archivedAt).toBeInstanceOf(Date);
      const reopened = await createDirectConversation(ctx.db, bot.id);
      expect(reopened.id).toBe(conv.id);
      expect(reopened.archivedAt).toBeNull();
    });

    it("is enforced by the database: one direct per bot, one bot per direct, kind cannot diverge", async () => {
      const a = await newBot();
      const b = await newBot();
      const direct = await createDirectConversation(ctx.db, a.id);
      const [second] = await ctx.db.sql<{ id: string }[]>`
        insert into conversations (kind) values ('direct') returning id`;
      await expect(
        ctx.db.sql`insert into conversation_members (conversation_id, conversation_kind, bot_id)
          values (${second?.id ?? ""}, 'direct', ${a.id})`,
      ).rejects.toThrow(/one_direct_per_bot/);
      await expect(
        ctx.db.sql`insert into conversation_members (conversation_id, conversation_kind, bot_id)
          values (${direct.id}, 'direct', ${b.id})`,
      ).rejects.toThrow(/one_bot_per_direct/);
      await expect(
        ctx.db.sql`insert into conversation_members (conversation_id, conversation_kind, bot_id)
          values (${direct.id}, 'group', ${b.id})`,
      ).rejects.toThrow(/foreign key/);
      await expect(ctx.db.sql`insert into conversations (kind) values ('channel')`).rejects.toThrow(
        /check/,
      );
    });

    it("does not allow member changes", async () => {
      const a = await newBot();
      const b = await newBot();
      const direct = await createDirectConversation(ctx.db, a.id);
      await expect(addMember(ctx.db, direct.id, b.id)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
      await expect(removeMember(ctx.db, direct.id, a.id)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
    });
  });

  describe("group conversations", () => {
    it("creates with a title and distinct members", async () => {
      const [a, b] = [await newBot("ga"), await newBot("gb")];
      const group = await createGroupConversation(ctx.db, {
        title: "  Study room ",
        botIds: [a?.id ?? "", b?.id ?? "", a?.id ?? ""],
      });
      expect(group).toMatchObject({ kind: "group", title: "Study room" });
      expect(group.members.map((m) => m.botId).sort()).toEqual([a?.id, b?.id].sort());
    });

    it("validates title, members and bots", async () => {
      const a = await newBot();
      await expect(
        createGroupConversation(ctx.db, { title: " ", botIds: [a.id] }),
      ).rejects.toThrow();
      await expect(createGroupConversation(ctx.db, { title: "x", botIds: [] })).rejects.toThrow();
      await expect(
        createGroupConversation(ctx.db, { title: "x", botIds: [a.id, UNKNOWN] }),
      ).rejects.toBeInstanceOf(ConversationRuleError);
      const archived = await newBot();
      await archiveBot(ctx.db, archived.id);
      await expect(
        createGroupConversation(ctx.db, { title: "x", botIds: [archived.id] }),
      ).rejects.toBeInstanceOf(ConversationRuleError);
      // nothing half-created
      const rows = await ctx.db.sql`select 1 from conversations where title = 'x'`;
      expect(rows).toHaveLength(0);
    });

    it("adds (idempotently) and removes members, never the last one", async () => {
      const [a, b, c] = [await newBot(), await newBot(), await newBot()];
      const group = await createGroupConversation(ctx.db, {
        title: "g",
        botIds: [a.id, b.id],
      });
      const added = await addMember(ctx.db, group.id, c.id);
      expect(added.members).toHaveLength(3);
      expect((await addMember(ctx.db, group.id, c.id)).members).toHaveLength(3);

      expect(
        (await removeMember(ctx.db, group.id, a.id)).members.map((m) => m.botId),
      ).not.toContain(a.id);
      expect((await removeMember(ctx.db, group.id, a.id)).members).toHaveLength(2); // not a member: no-op
      await removeMember(ctx.db, group.id, b.id);
      await expect(removeMember(ctx.db, group.id, c.id)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
    });

    it("rejects unknown conversations, unknown bots and archived conversations", async () => {
      const a = await newBot();
      const group = await createGroupConversation(ctx.db, { title: "g", botIds: [a.id] });
      await expect(addMember(ctx.db, UNKNOWN, a.id)).rejects.toBeInstanceOf(
        ConversationNotFoundError,
      );
      await expect(addMember(ctx.db, group.id, UNKNOWN)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
      await archiveConversation(ctx.db, group.id);
      await expect(addMember(ctx.db, group.id, (await newBot()).id)).rejects.toBeInstanceOf(
        ConversationRuleError,
      );
    });
  });

  describe("archive and listing", () => {
    it("archives idempotently and returns null for unknown ids", async () => {
      const a = await newBot();
      const group = await createGroupConversation(ctx.db, { title: "g", botIds: [a.id] });
      const first = await archiveConversation(ctx.db, group.id);
      expect(first?.archivedAt).toBeInstanceOf(Date);
      expect((await archiveConversation(ctx.db, group.id))?.archivedAt).toEqual(first?.archivedAt);
      expect(await archiveConversation(ctx.db, UNKNOWN)).toBeNull();
      expect(await getConversation(ctx.db, UNKNOWN)).toBeNull();
    });
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("conversation list and run links"), () => {
  const ctx = useIsolatedDb();
  const newBot = (name: string): Promise<Bot> =>
    createBot(ctx.db, { name, modelProvider: "fake", modelId: "fake-1" });

  it("orders by last message (nulls last), with members and a truncated last-message preview", async () => {
    const [a, b, c] = [await newBot("A"), await newBot("B"), await newBot("C")];
    const quiet = await createDirectConversation(ctx.db, c.id); // never has a message
    const older = await createDirectConversation(ctx.db, a.id);
    const group = await createGroupConversation(ctx.db, { title: "Room", botIds: [a.id, b.id] });

    await appendMessage(ctx.db, { conversationId: older.id, authorKind: "user", text: "first" });
    await appendMessage(ctx.db, { conversationId: group.id, authorKind: "user", text: "hello" });
    const long = "x".repeat(MESSAGE_PREVIEW_LENGTH + 50);
    await appendMessage(ctx.db, {
      conversationId: group.id,
      authorKind: "bot",
      authorBotId: b.id,
      text: long,
    });

    const list = await listConversations(ctx.db);
    expect(list.map((x) => x.id)).toEqual([group.id, older.id, quiet.id]);

    const [g, o, q] = list;
    expect(g?.members.map((m) => m.name).sort()).toEqual(["A", "B"]);
    expect(g?.lastMessage).toMatchObject({ seq: 2, authorKind: "bot", authorBotId: b.id });
    expect(g?.lastMessage?.text).toBe("x".repeat(MESSAGE_PREVIEW_LENGTH));
    expect(g?.lastMessageAt).toBeInstanceOf(Date);
    expect(o?.lastMessage).toMatchObject({ seq: 1, text: "first", authorKind: "user" });
    expect(q?.lastMessage).toBeNull();
    expect(q?.lastMessageAt).toBeNull();

    // A new message moves its conversation to the top.
    await appendMessage(ctx.db, { conversationId: older.id, authorKind: "user", text: "again" });
    expect((await listConversations(ctx.db)).map((x) => x.id)).toEqual([
      older.id,
      group.id,
      quiet.id,
    ]);
    expect((await listConversations(ctx.db, { limit: 1 })).map((x) => x.id)).toEqual([older.id]);
  });

  it("hides archived conversations unless asked", async () => {
    const bot = await newBot("Z");
    const conv = await createGroupConversation(ctx.db, { title: "old", botIds: [bot.id] });
    await archiveConversation(ctx.db, conv.id);
    expect((await listConversations(ctx.db)).map((c) => c.id)).not.toContain(conv.id);
    expect((await listConversations(ctx.db, { includeArchived: true })).map((c) => c.id)).toContain(
      conv.id,
    );
  });

  it("links runs to conversations and filters listRuns by them", async () => {
    const bot = await newBot("R");
    const conv = await createDirectConversation(ctx.db, bot.id);
    const inConv = await createRun(ctx.db, {
      botId: bot.id,
      origin: "user",
      objective: "from chat",
      conversationId: conv.id,
    });
    const routine = await createRun(ctx.db, {
      botId: bot.id,
      origin: "routine",
      objective: "cron",
    });
    expect(inConv.conversationId).toBe(conv.id);
    expect(routine.conversationId).toBeNull();

    expect(
      (await listRuns(ctx.db, { conversationId: conv.id, limit: 10 })).map((r) => r.id),
    ).toEqual([inConv.id]);
    expect((await listRuns(ctx.db, { botId: bot.id, limit: 10 })).map((r) => r.id).sort()).toEqual(
      [inConv.id, routine.id].sort(),
    );
    await expect(
      createRun(ctx.db, {
        botId: bot.id,
        origin: "user",
        objective: "x",
        conversationId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/foreign key/);
  });
});
