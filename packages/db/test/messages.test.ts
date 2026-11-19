import { describe, expect, it } from "vitest";
import {
  appendMessage,
  archiveConversation,
  type Bot,
  ConversationNotFoundError,
  ConversationRuleError,
  createBot,
  createDirectConversation,
  createGroupConversation,
  createRun,
  getConversation,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  listMessages,
  markMessageDelivered,
  searchMessages,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!DATABASE_URL)(dbSuiteName("messages"), () => {
  const ctx = useIsolatedDb();

  const newBot = (name = "bot"): Promise<Bot> =>
    createBot(ctx.db, { name, modelProvider: "fake", modelId: "fake-1" });
  const newDirect = async () => {
    const bot = await newBot();
    return { bot, conv: await createDirectConversation(ctx.db, bot.id) };
  };
  const say = (conversationId: string, text: string) =>
    appendMessage(ctx.db, { conversationId, authorKind: "user", text });

  describe("append", () => {
    it("numbers messages from 1 and bumps last_message_at", async () => {
      const { bot, conv } = await newDirect();
      const m1 = await say(conv.id, "oi");
      const m2 = await appendMessage(ctx.db, {
        conversationId: conv.id,
        authorKind: "bot",
        authorBotId: bot.id,
        text: "olá!",
      });
      const m3 = await appendMessage(ctx.db, {
        conversationId: conv.id,
        authorKind: "system",
        text: "salvo na memória",
      });
      expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);
      expect(m1).toMatchObject({
        conversationId: conv.id,
        authorKind: "user",
        authorBotId: null,
        runId: null,
        status: null,
      });
      expect(m2.authorBotId).toBe(bot.id);
      const after = await getConversation(ctx.db, conv.id);
      expect(after?.lastMessageAt).toEqual(m3.createdAt);
      expect(after?.lastMessage?.seq).toBe(3);
    });

    it("produces gapless, unique seq under 20 concurrent appends", async () => {
      const { conv } = await newDirect();
      const messages = await Promise.all(
        Array.from({ length: 20 }, (_, i) => say(conv.id, `m${i}`)),
      );
      expect(messages.map((m) => m.seq).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      const stored = await listMessages(ctx.db, conv.id, { limit: 100 });
      expect(stored.map((m) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(new Set(stored.map((m) => m.text)).size).toBe(20);
      // created_at follows seq, so the order by time and by seq agree.
      const times = stored.map((m) => m.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const after = await getConversation(ctx.db, conv.id);
      expect(after?.lastMessageAt).toEqual(stored.at(-1)?.createdAt);
    });

    it("keeps separate numbering per conversation", async () => {
      const [x, y] = [await newDirect(), await newDirect()];
      await say(x.conv.id, "a");
      await say(x.conv.id, "b");
      expect((await say(y.conv.id, "c")).seq).toBe(1);
    });

    it("links a message to a run", async () => {
      const { bot, conv } = await newDirect();
      const run = await createRun(ctx.db, {
        botId: bot.id,
        origin: "user",
        objective: "x",
        conversationId: conv.id,
      });
      const m = await appendMessage(ctx.db, {
        conversationId: conv.id,
        authorKind: "user",
        text: "faça isso",
        runId: run.id,
      });
      expect(m.runId).toBe(run.id);
      await expect(
        appendMessage(ctx.db, {
          conversationId: conv.id,
          authorKind: "user",
          text: "x",
          runId: UNKNOWN,
        }),
      ).rejects.toThrow(/foreign key/);
    });

    it("rejects unknown and archived conversations, and writes nothing", async () => {
      await expect(say(UNKNOWN, "x")).rejects.toBeInstanceOf(ConversationNotFoundError);
      const { conv } = await newDirect();
      await say(conv.id, "before");
      await archiveConversation(ctx.db, conv.id);
      await expect(say(conv.id, "after")).rejects.toBeInstanceOf(ConversationRuleError);
      expect(await listMessages(ctx.db, conv.id, { limit: 10 })).toHaveLength(1);
    });
  });

  describe("author rules", () => {
    it("requires a bot author exactly for bot messages (code)", async () => {
      const { bot, conv } = await newDirect();
      await expect(
        appendMessage(ctx.db, { conversationId: conv.id, authorKind: "bot", text: "x" }),
      ).rejects.toThrow(/authorBotId/);
      await expect(
        appendMessage(ctx.db, {
          conversationId: conv.id,
          authorKind: "user",
          authorBotId: bot.id,
          text: "x",
        }),
      ).rejects.toThrow(/authorBotId/);
      await expect(
        appendMessage(ctx.db, { conversationId: conv.id, authorKind: "user", text: "   " }),
      ).rejects.toThrow(/blank/);
      await expect(
        appendMessage(ctx.db, { conversationId: conv.id, authorKind: "other" as never, text: "x" }),
      ).rejects.toThrow();
    });

    it("only lets members of the conversation speak as a bot", async () => {
      const { conv } = await newDirect();
      const stranger = await newBot("stranger");
      await expect(
        appendMessage(ctx.db, {
          conversationId: conv.id,
          authorKind: "bot",
          authorBotId: stranger.id,
          text: "hi",
        }),
      ).rejects.toBeInstanceOf(ConversationRuleError);
      const group = await createGroupConversation(ctx.db, { title: "g", botIds: [stranger.id] });
      expect(
        (
          await appendMessage(ctx.db, {
            conversationId: group.id,
            authorKind: "bot",
            authorBotId: stranger.id,
            text: "hi",
          })
        ).authorBotId,
      ).toBe(stranger.id);
    });

    it("is enforced by the database too (raw inserts)", async () => {
      const { bot, conv } = await newDirect();
      const insert = (kind: string, botId: string | null, status: string | null, text = "t") =>
        ctx.db.sql`
          insert into messages (conversation_id, seq, author_kind, author_bot_id, text, status)
          values (${conv.id}, ${Math.floor(Math.random() * 1e9) + 1000}, ${kind}, ${botId}, ${text}, ${status})`;
      await expect(insert("bot", null, null)).rejects.toThrow(/messages_author_bot_iff_bot/);
      await expect(insert("user", bot.id, null)).rejects.toThrow(/messages_author_bot_iff_bot/);
      await expect(insert("system", null, "sent")).rejects.toThrow(/messages_status_only_for_user/);
      await expect(insert("bot", bot.id, "sent")).rejects.toThrow(/messages_status_only_for_user/);
      await expect(insert("user", null, "read")).rejects.toThrow(/check/);
      await expect(insert("alien", null, null)).rejects.toThrow(/check/);
      await expect(insert("user", null, null, "  ")).rejects.toThrow(/check/);
      await expect(
        ctx.db.sql`insert into messages (conversation_id, seq, author_kind, text)
          values (${conv.id}, 0, 'user', 'zero')`,
      ).rejects.toThrow(/check/);
      await expect(insert("user", null, "sent")).resolves.toBeDefined();
    });

    it("refuses a duplicate (conversation, seq) at the database", async () => {
      const { conv } = await newDirect();
      await say(conv.id, "one");
      await expect(
        ctx.db.sql`insert into messages (conversation_id, seq, author_kind, text)
          values (${conv.id}, 1, 'user', 'dup')`,
      ).rejects.toThrow(/duplicate key/);
    });
  });

  describe("delivery status", () => {
    it("starts as sent and becomes delivered once, idempotently", async () => {
      const { conv } = await newDirect();
      const m = await appendMessage(ctx.db, {
        conversationId: conv.id,
        authorKind: "user",
        text: "while you work",
        status: "sent",
      });
      expect(m.status).toBe("sent");
      const delivered = await markMessageDelivered(ctx.db, m.id);
      expect(delivered?.status).toBe("delivered");
      expect((await markMessageDelivered(ctx.db, m.id))?.status).toBe("delivered");
    });

    it("leaves messages without status alone and returns null for unknown ids", async () => {
      const { conv } = await newDirect();
      const plain = await say(conv.id, "plain");
      expect(await markMessageDelivered(ctx.db, plain.id)).toEqual(plain);
      expect(await markMessageDelivered(ctx.db, UNKNOWN)).toBeNull();
    });

    it("rejects a status on a non-user message", async () => {
      const { bot, conv } = await newDirect();
      await expect(
        appendMessage(ctx.db, {
          conversationId: conv.id,
          authorKind: "bot",
          authorBotId: bot.id,
          text: "x",
          status: "sent",
        }),
      ).rejects.toThrow(/status/);
    });
  });

  describe("paging", () => {
    it("returns the newest page first-class, then walks back with beforeSeq, and forward with afterSeq", async () => {
      const { conv } = await newDirect();
      for (let i = 1; i <= 10; i++) await say(conv.id, `m${i}`);
      const seqs = async (o: Parameters<typeof listMessages>[2]) =>
        (await listMessages(ctx.db, conv.id, o)).map((m) => m.seq);

      expect(await seqs({ limit: 3 })).toEqual([8, 9, 10]);
      expect(await seqs({ limit: 3, beforeSeq: 8 })).toEqual([5, 6, 7]);
      expect(await seqs({ limit: 3, beforeSeq: 2 })).toEqual([1]);
      expect(await seqs({ limit: 3, beforeSeq: 1 })).toEqual([]);
      expect(await seqs({ limit: 3, afterSeq: 4 })).toEqual([5, 6, 7]);
      expect(await seqs({ limit: 5, afterSeq: 8 })).toEqual([9, 10]);
      expect(await seqs({ limit: 100 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await seqs({ limit: 2, afterSeq: 2, beforeSeq: 9 })).toEqual([7, 8]);
      expect(await seqs({ limit: 10, afterSeq: 2, beforeSeq: 6 })).toEqual([3, 4, 5]);
    });

    it("validates the limit and returns nothing for an empty or unknown conversation", async () => {
      const { conv } = await newDirect();
      expect(await listMessages(ctx.db, conv.id, { limit: 5 })).toEqual([]);
      expect(await listMessages(ctx.db, UNKNOWN, { limit: 5 })).toEqual([]);
      await expect(listMessages(ctx.db, conv.id, { limit: 0 })).rejects.toThrow();
    });
  });

  describe("search", () => {
    const hl = (s: string) => s.replaceAll(HIGHLIGHT_START, "[").replaceAll(HIGHLIGHT_END, "]");

    it("matches Portuguese stems: 'provas' finds 'prova', and the other way round", async () => {
      const { conv } = await newDirect();
      await say(conv.id, "Preciso estudar para a prova de cálculo na sexta.");
      await say(conv.id, "Nada a ver com isso.");
      const hits = await searchMessages(ctx.db, {
        query: "provas",
        conversationId: conv.id,
        limit: 10,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.message.text).toContain("prova de cálculo");
      expect(hits[0]?.rank).toBeGreaterThan(0);
      expect(hl(hits[0]?.excerpt ?? "")).toContain("[prova]");
      const back = await searchMessages(ctx.db, {
        query: "prova",
        conversationId: conv.id,
        limit: 10,
      });
      expect(back).toHaveLength(1);
    });

    it("handles accented words and their inflections", async () => {
      const { conv } = await newDirect();
      await say(conv.id, "A avaliação de português é amanhã, não esqueça.");
      await say(conv.id, "Comprei pão e açúcar.");
      const find = async (q: string) =>
        (await searchMessages(ctx.db, { query: q, conversationId: conv.id, limit: 10 })).map(
          (h) => h.message.text,
        );
      expect(await find("avaliações")).toEqual(["A avaliação de português é amanhã, não esqueça."]);
      expect(await find("AVALIAÇÃO")).toHaveLength(1);
      expect(await find("português")).toHaveLength(1);
      expect(await find("açúcar")).toEqual(["Comprei pão e açúcar."]);
      expect(await find("pães")).toEqual(["Comprei pão e açúcar."]);
    });

    it("ranks the better match first and highlights it", async () => {
      const { conv } = await newDirect();
      await say(conv.id, "Lembrete: a reunião do grupo é na terça.");
      const strong = await say(conv.id, "Reunião, reunião, reunião: a reunião mudou de horário.");
      await say(conv.id, "Nenhuma relação.");
      const hits = await searchMessages(ctx.db, {
        query: "reunião",
        conversationId: conv.id,
        limit: 10,
      });
      expect(hits).toHaveLength(2);
      expect(hits[0]?.message.id).toBe(strong.id);
      expect(hits[0]?.rank ?? 0).toBeGreaterThan(hits[1]?.rank ?? 1);
      expect(hl(hits[1]?.excerpt ?? "")).toContain("[reunião]");
      expect(
        await searchMessages(ctx.db, { query: "reunião", conversationId: conv.id, limit: 1 }),
      ).toHaveLength(1);
    });

    it("scopes by conversation and by bot membership", async () => {
      const [a, b] = [await newBot("sa"), await newBot("sb")];
      const [ca, cb] = [
        await createDirectConversation(ctx.db, a.id),
        await createDirectConversation(ctx.db, b.id),
      ];
      const shared = await createGroupConversation(ctx.db, { title: "g", botIds: [a.id, b.id] });
      await say(ca.id, "zebra listrada A");
      await say(cb.id, "zebra listrada B");
      await say(shared.id, "zebra listrada grupo");

      const text = async (o: { conversationId?: string; botId?: string }) =>
        (await searchMessages(ctx.db, { query: "zebra", limit: 10, ...o }))
          .map((h) => h.message.text)
          .sort();
      expect(await text({})).toHaveLength(3);
      expect(await text({ conversationId: cb.id })).toEqual(["zebra listrada B"]);
      expect(await text({ botId: a.id })).toEqual(["zebra listrada A", "zebra listrada grupo"]);
      expect(await text({ botId: b.id, conversationId: ca.id })).toEqual([]);
    });

    it("never errors on hostile query strings", async () => {
      const { conv } = await newDirect();
      await say(conv.id, "O gato preto dorme no sofá.");
      const hostile = [
        "",
        "   ",
        '"',
        '"gato',
        'gato"',
        "'",
        "'; drop table messages; --",
        "gato & | ! ( )",
        "gato <-> sofá",
        ":*",
        "gato:*",
        "!gato",
        "-gato",
        "gato or",
        "or or or",
        "(((",
        "\\",
        "a e o de",
        "de a o",
        "%_",
        "é",
        "\u0000gato",
        "gato\u0000",
        "x".repeat(1000),
      ];
      for (const query of hostile) {
        await expect(searchMessages(ctx.db, { query, limit: 5 })).resolves.toBeDefined();
      }
      // websearch syntax is honored, not executed as SQL or raw tsquery
      expect(await searchMessages(ctx.db, { query: '"gato preto"', limit: 5 })).toHaveLength(1);
      expect(await searchMessages(ctx.db, { query: "gato -preto", limit: 5 })).toHaveLength(0);
      expect(await searchMessages(ctx.db, { query: "gato or cachorro", limit: 5 })).toHaveLength(1);
      // no searchable terms at all: empty, not an error
      expect(await searchMessages(ctx.db, { query: "a e o de", limit: 5 })).toEqual([]);
      expect(await searchMessages(ctx.db, { query: "!!! ???", limit: 5 })).toEqual([]);
      expect(await searchMessages(ctx.db, { query: "", limit: 5 })).toEqual([]);
      const [count] = await ctx.db.sql<{ n: string }[]>`select count(*) as n from messages`;
      expect(Number(count?.n)).toBeGreaterThan(0); // the table is still there
      await expect(
        searchMessages(ctx.db, { query: "x", limit: 5, conversationId: "not-a-uuid" }),
      ).rejects.toThrow();
      await expect(searchMessages(ctx.db, { query: "x".repeat(1001), limit: 5 })).rejects.toThrow();
    });
  });
});
