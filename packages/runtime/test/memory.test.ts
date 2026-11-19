import { MemoryRuleError } from "@suup/core";
import {
  addMemory,
  appendMessage,
  archiveMemory,
  createBot,
  createDirectConversation,
  createRun,
  getMemory,
  restoreMemory,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import { createMemoryService, loadRunContext } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("memory service and run context"), () => {
  const ctx = useIsolatedDb();
  let n = 0;

  async function world() {
    const bot = await createBot(ctx.db, { name: `b${++n}`, modelProvider: "p", modelId: "m" });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const run = await createRun(ctx.db, {
      botId: bot.id,
      conversationId: conversation.id,
      origin: "user",
      objective: "agora",
    });
    const opening = await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "user",
      text: "agora",
      runId: run.id,
    });
    const service = createMemoryService(ctx.db, { botId: bot.id, runId: run.id });
    return { bot, conversation, run, opening, service };
  }

  describe("MemoryService", () => {
    it("saves as the bot, with the run, conversation and opening message as its origin", async () => {
      const w = await world();
      const { id } = await w.service.remember({
        layer: "profile",
        text: "O usuário mora em Recife.",
      });
      const saved = await getMemory(ctx.db, id);
      expect(saved).toMatchObject({
        layer: "profile",
        scope: "shared",
        botId: null,
        createdBy: "bot",
        sourceRunId: w.run.id,
        sourceConversationId: w.conversation.id,
        sourceMessageId: w.opening.id,
      });
    });

    it("layers and scopes: a rule is shared unless told otherwise, a note is the bot's, wrong combinations are refused", async () => {
      const w = await world();
      const shared = await w.service.remember({ layer: "rule", text: "Responda em português." });
      const mine = await w.service.remember({
        layer: "rule",
        text: "Só eu uso tom formal.",
        scope: "bot",
      });
      const note = await w.service.remember({
        layer: "note",
        text: "O deploy fica em tools/deploy.sh.",
      });
      expect(await getMemory(ctx.db, shared.id)).toMatchObject({ scope: "shared", botId: null });
      expect(await getMemory(ctx.db, mine.id)).toMatchObject({ scope: "bot", botId: w.bot.id });
      expect(await getMemory(ctx.db, note.id)).toMatchObject({
        scope: "bot",
        botId: w.bot.id,
        createdBy: "bot",
      });
      await expect(
        w.service.remember({ layer: "note", text: "isto é compartilhado?", scope: "shared" }),
      ).rejects.toBeInstanceOf(MemoryRuleError);
      await expect(
        w.service.remember({ layer: "profile", text: "fato só meu", scope: "bot" }),
      ).rejects.toBeInstanceOf(MemoryRuleError);
    });

    it("saving the same text again returns the memory that exists", async () => {
      const w = await world();
      const a = await w.service.remember({ layer: "profile", text: "Gosta de café." });
      const b = await w.service.remember({ layer: "profile", text: "  gosta   de CAFÉ. " });
      expect(b.id).toBe(a.id);
      const x = await w.service.remember({ layer: "note", text: "usa pnpm" });
      expect((await w.service.remember({ layer: "note", text: "usa pnpm" })).id).toBe(x.id);
    });

    it("a bot sees the shared memories and its own, never another bot's notes", async () => {
      const a = await world();
      const b = await world();
      await a.service.remember({ layer: "note", text: "segredo-do-bot-a: chave da planilha azul" });
      await addMemory(ctx.db, {
        layer: "profile",
        text: "planilha compartilhada de despesas",
        createdBy: "user",
      });
      const seenByA = await a.service.recall({ query: "planilha" });
      const seenByB = await b.service.recall({ query: "planilha" });
      expect(seenByA.map((h) => h.layer).sort()).toEqual(["note", "profile"]);
      expect(seenByB.map((h) => h.layer)).toEqual(["profile"]);
      // Excerpts come back as plain text.
      for (const hit of seenByA) {
        expect(hit.excerpt.includes("\u0002") || hit.excerpt.includes("\u0003")).toBe(false);
      }
      // Layers filter.
      expect(
        (await a.service.recall({ query: "planilha", layers: ["note"] })).map((h) => h.layer),
      ).toEqual(["note"]);
    });

    it("forget archives what the bot can see; another bot's note and unknown ids are refused", async () => {
      const a = await world();
      const b = await world();
      const note = await a.service.remember({
        layer: "note",
        text: "nota privada do bot a sobre bule",
      });
      expect(await b.service.forget({ id: note.id })).toBe(false);
      expect((await getMemory(ctx.db, note.id))?.archivedAt).toBeNull();
      expect(await a.service.forget({ id: note.id })).toBe(true);
      expect((await getMemory(ctx.db, note.id))?.archivedAt).not.toBeNull();
      expect(await a.service.forget({ id: note.id })).toBe(false); // already forgotten
      expect(await a.service.forget({ id: "not-a-uuid" })).toBe(false);
      expect(await a.service.recall({ query: "bule" })).toEqual([]);
      // A shared memory can be forgotten by any bot.
      const rule = await addMemory(ctx.db, {
        layer: "rule",
        text: "regra do usuário sobre chá",
        createdBy: "user",
      });
      expect(await b.service.forget({ id: rule.id })).toBe(true);
    });

    it("searches the past messages of the bot's own conversations only", async () => {
      const a = await world();
      const b = await world();
      await appendMessage(ctx.db, {
        conversationId: a.conversation.id,
        authorKind: "user",
        text: "Meu cachorro se chama Bolt e adora bolinhas.",
      });
      const hits = await a.service.searchConversations({ query: "cachorro" });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ conversationId: a.conversation.id, author: "user" });
      expect(hits[0]?.excerpt).toContain("cachorro");
      expect(await b.service.searchConversations({ query: "cachorro" })).toEqual([]);
    });
  });

  describe("loadRunContext", () => {
    /** A conversation with `texts` as alternating user/bot messages, then a run opened by a last message. */
    async function talk(texts: string[], opening = "mensagem de agora") {
      const bot = await createBot(ctx.db, { name: `c${++n}`, modelProvider: "p", modelId: "m" });
      const conversation = await createDirectConversation(ctx.db, bot.id);
      for (const [i, text] of texts.entries()) {
        await appendMessage(ctx.db, {
          conversationId: conversation.id,
          authorKind: i % 2 === 0 ? "user" : "bot",
          ...(i % 2 === 0 ? {} : { authorBotId: bot.id }),
          text,
        });
      }
      const run = await createRun(ctx.db, {
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        objective: opening,
      });
      await appendMessage(ctx.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: opening,
        runId: run.id,
      });
      return { bot, conversation, run };
    }

    const flat = (h: { role: string; blocks: { type: string; text?: string }[] }[]) =>
      h.map((m) => [m.role, m.blocks.map((b) => b.text).join("")]);

    it("rules and profile from memory, in a stable order; history is the earlier turns as user/assistant", async () => {
      const { bot, run } = await talk([
        "Oi",
        "Olá! Como posso ajudar?",
        "Meu nome é Marina",
        "Prazer, Marina.",
      ]);
      const first = await addMemory(ctx.db, { layer: "rule", text: "regra 1", createdBy: "user" });
      const mineOnly = await addMemory(ctx.db, {
        layer: "rule",
        botId: bot.id,
        text: "regra do bot",
        createdBy: "user",
      });
      const other = await createBot(ctx.db, { name: `z${++n}`, modelProvider: "p", modelId: "m" });
      await addMemory(ctx.db, {
        layer: "rule",
        botId: other.id,
        text: "regra de outro bot",
        createdBy: "user",
      });
      const fact = await addMemory(ctx.db, {
        layer: "profile",
        text: "Mora em Recife.",
        createdBy: "user",
      });
      await addMemory(ctx.db, { layer: "note", botId: bot.id, text: "uma nota", createdBy: "bot" });

      const snapshot = await loadRunContext(ctx.db, run.id);
      expect(snapshot.rules.map((r) => r.id)).toEqual(
        expect.arrayContaining([first.id, mineOnly.id]),
      );
      expect(snapshot.rules.map((r) => r.text)).not.toContain("regra de outro bot");
      expect(snapshot.profile.map((p) => p.id)).toContain(fact.id);
      expect(snapshot.rules.map((r) => r.text)).not.toContain("uma nota");
      expect(flat(snapshot.history)).toEqual([
        ["user", "Oi"],
        ["assistant", "Olá! Como posso ajudar?"],
        ["user", "Meu nome é Marina"],
        ["assistant", "Prazer, Marina."],
      ]);
      expect(snapshot.historyNote).toBeUndefined();
      // Stable: the same call gives the same snapshot.
      expect(await loadRunContext(ctx.db, run.id)).toEqual(snapshot);
    });

    it("the history stops before the message that opened the run (what came after is not history)", async () => {
      const { conversation, run } = await talk(["antes"], "abre a execução");
      await appendMessage(ctx.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: "mensagem enviada depois",
        status: "sent",
        runId: run.id,
      });
      const snapshot = await loadRunContext(ctx.db, run.id);
      expect(flat(snapshot.history)).toEqual([["user", "antes"]]);
    });

    it("merges messages of the same role so roles alternate, and keeps system messages as bracketed notes", async () => {
      const bot = await createBot(ctx.db, { name: `m${++n}`, modelProvider: "p", modelId: "m" });
      const conversation = await createDirectConversation(ctx.db, bot.id);
      const add = (authorKind: "user" | "bot" | "system", text: string) =>
        appendMessage(ctx.db, {
          conversationId: conversation.id,
          authorKind,
          ...(authorKind === "bot" ? { authorBotId: bot.id } : {}),
          text,
        });
      await add("user", "faça X");
      await add("system", "Não consegui concluir esta tarefa.");
      await add("user", "tente de novo");
      await add("bot", "Feito.");
      await add("bot", "Mais uma coisa.");
      const run = await createRun(ctx.db, {
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        objective: "agora",
      });
      await appendMessage(ctx.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: "agora",
        runId: run.id,
      });
      const { history } = await loadRunContext(ctx.db, run.id);
      expect(flat(history)).toEqual([
        ["user", "faça X\n\n[System message: Não consegui concluir esta tarefa.]\n\ntente de novo"],
        ["assistant", "Feito.\n\nMais uma coisa."],
      ]);
    });

    it("cuts on whole messages, newest first, within the budget, and says that older ones were left out", async () => {
      const long = (c: string) => c.repeat(100);
      const { run } = await talk([
        long("a"),
        long("b"),
        long("c"),
        long("d"),
        "e curto",
        "f curto",
      ]);
      // Newest first: 7 + 7 + 100 + 100 = 214 fits in 250; one more would be 314.
      const snapshot = await loadRunContext(ctx.db, run.id, 250);
      expect(flat(snapshot.history)).toEqual([
        ["user", long("c")],
        ["assistant", long("d")],
        ["user", "e curto"],
        ["assistant", "f curto"],
      ]);
      expect(snapshot.historyNote).toMatch(/2 older/);
      expect(snapshot.historyNote).toMatch(/search_conversations/);

      // Everything fits: no note.
      const all = await loadRunContext(ctx.db, run.id, 10_000);
      expect(all.history).toHaveLength(6);
      expect(all.historyNote).toBeUndefined();
      // Nothing fits: no history, but the note still tells the model there is more.
      const none = await loadRunContext(ctx.db, run.id, 3);
      expect(none.history).toEqual([]);
      expect(none.historyNote).toMatch(/search_conversations/);
    });

    it("a run without a conversation gets rules and profile only", async () => {
      const bot = await createBot(ctx.db, { name: `n${++n}`, modelProvider: "p", modelId: "m" });
      const run = await createRun(ctx.db, { botId: bot.id, origin: "routine", objective: "x" });
      await addMemory(ctx.db, { layer: "profile", text: "fato para todos", createdBy: "user" });
      const snapshot = await loadRunContext(ctx.db, run.id);
      expect(snapshot.history).toEqual([]);
      expect(snapshot.historyNote).toBeUndefined();
      expect(snapshot.profile.map((p) => p.text)).toContain("fato para todos");
    });

    it("forgotten memories are not part of the context", async () => {
      const bot = await createBot(ctx.db, { name: `f${++n}`, modelProvider: "p", modelId: "m" });
      const run = await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "x" });
      const rule = await addMemory(ctx.db, {
        layer: "rule",
        text: "esquecível XYZ",
        createdBy: "user",
      });
      expect((await loadRunContext(ctx.db, run.id)).rules.map((r) => r.id)).toContain(rule.id);
      await archiveMemory(ctx.db, rule.id);
      expect((await loadRunContext(ctx.db, run.id)).rules.map((r) => r.id)).not.toContain(rule.id);
      await restoreMemory(ctx.db, rule.id);
      expect((await loadRunContext(ctx.db, run.id)).rules.map((r) => r.id)).toContain(rule.id);
    });
  });
});
