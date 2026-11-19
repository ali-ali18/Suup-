import { describe, expect, it } from "vitest";
import {
  addMemory,
  appendMessage,
  archiveMemory,
  type Bot,
  createBot,
  createDirectConversation,
  createRun,
  getMemory,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  listMemories,
  type Memory,
  memoryContextFor,
  restoreMemory,
  searchMemories,
  updateMemory,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!DATABASE_URL)(dbSuiteName("memories"), () => {
  const ctx = useIsolatedDb();

  const newBot = (name = "bot"): Promise<Bot> =>
    createBot(ctx.db, { name, modelProvider: "fake", modelId: "fake-1" });
  const ids = (ms: Memory[]) => ms.map((m) => m.id);
  const texts = (ms: Memory[]) => ms.map((m) => m.text);

  describe("add and constraints", () => {
    it("defaults the scope by layer and stores the origin", async () => {
      const bot = await newBot();
      const conv = await createDirectConversation(ctx.db, bot.id);
      const msg = await appendMessage(ctx.db, {
        conversationId: conv.id,
        authorKind: "user",
        text: "meu curso é Direito",
      });
      const run = await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "x" });

      const profile = await addMemory(ctx.db, {
        layer: "profile",
        text: "Estuda Direito.",
        createdBy: "bot",
        sourceConversationId: conv.id,
        sourceRunId: run.id,
        sourceMessageId: msg.id,
      });
      expect(profile).toMatchObject({
        layer: "profile",
        scope: "shared",
        botId: null,
        createdBy: "bot",
        sourceConversationId: conv.id,
        sourceRunId: run.id,
        sourceMessageId: msg.id,
        embeddingReady: false,
        archivedAt: null,
      });
      expect(await getMemory(ctx.db, profile.id)).toEqual(profile);

      const note = await addMemory(ctx.db, {
        layer: "note",
        botId: bot.id,
        text: "n",
        createdBy: "bot",
      });
      expect(note).toMatchObject({ scope: "bot", botId: bot.id, sourceConversationId: null });
      expect(
        (await addMemory(ctx.db, { layer: "journal", botId: bot.id, text: "j", createdBy: "bot" }))
          .scope,
      ).toBe("bot");
      expect((await addMemory(ctx.db, { layer: "rule", text: "r", createdBy: "user" })).scope).toBe(
        "shared",
      );
      expect(
        (await addMemory(ctx.db, { layer: "rule", botId: bot.id, text: "r", createdBy: "user" }))
          .scope,
      ).toBe("bot");
      expect(await getMemory(ctx.db, UNKNOWN)).toBeNull();
    });

    it("rejects invalid layer/scope/bot combinations in code", async () => {
      const bot = await newBot();
      const add = (i: Parameters<typeof addMemory>[1]) => addMemory(ctx.db, i);
      await expect(
        add({ layer: "profile", scope: "bot", botId: bot.id, text: "x", createdBy: "user" }),
      ).rejects.toThrow(/shared/);
      await expect(
        add({ layer: "note", scope: "shared", text: "x", createdBy: "user" }),
      ).rejects.toThrow(/one bot/);
      await expect(
        add({ layer: "journal", scope: "shared", text: "x", createdBy: "user" }),
      ).rejects.toThrow(/one bot/);
      await expect(add({ layer: "note", text: "x", createdBy: "bot" })).rejects.toThrow(/botId/);
      await expect(
        add({ layer: "profile", botId: bot.id, text: "x", createdBy: "user" }),
      ).rejects.toThrow(/botId/);
      await expect(
        add({ layer: "rule", scope: "bot", text: "x", createdBy: "user" }),
      ).rejects.toThrow(/botId/);
      await expect(
        add({ layer: "rule", scope: "shared", botId: bot.id, text: "x", createdBy: "user" }),
      ).rejects.toThrow(/botId/);
      await expect(add({ layer: "rule", text: "  ", createdBy: "user" })).rejects.toThrow(/blank/);
      await expect(add({ layer: "wish" as never, text: "x", createdBy: "user" })).rejects.toThrow();
      await expect(
        add({ layer: "rule", text: "x", createdBy: "robot" as never }),
      ).rejects.toThrow();
    });

    it("is enforced by the database too (raw inserts)", async () => {
      const bot = await newBot();
      const insert = (
        layer: string,
        scope: string,
        botId: string | null,
        by = "user",
        text = "t",
      ) =>
        ctx.db.sql`insert into memories (layer, scope, bot_id, text, created_by)
          values (${layer}, ${scope}, ${botId}, ${text}, ${by})`;
      await expect(insert("profile", "bot", bot.id)).rejects.toThrow(/memories_profile_is_shared/);
      await expect(insert("note", "shared", null)).rejects.toThrow(/memories_notes_are_per_bot/);
      await expect(insert("journal", "shared", null)).rejects.toThrow(/memories_notes_are_per_bot/);
      await expect(insert("rule", "bot", null)).rejects.toThrow(/memories_bot_iff_bot_scope/);
      await expect(insert("rule", "shared", bot.id)).rejects.toThrow(/memories_bot_iff_bot_scope/);
      await expect(insert("rule", "global", null)).rejects.toThrow(/check/);
      await expect(insert("rule", "shared", null, "robot")).rejects.toThrow(/check/);
      await expect(insert("rule", "shared", null, "user", " ")).rejects.toThrow(/check/);
      await expect(insert("rule", "bot", UNKNOWN)).rejects.toThrow(/foreign key/);
      await expect(insert("rule", "shared", null)).resolves.toBeDefined();
      await expect(insert("rule", "bot", bot.id)).resolves.toBeDefined();
      await expect(insert("profile", "shared", null)).resolves.toBeDefined();
    });
  });

  describe("update, archive and restore", () => {
    it("updates only the text, bumps updated_at and marks the embedding stale", async () => {
      const m = await addMemory(ctx.db, {
        layer: "profile",
        text: "Mora em Recife.",
        createdBy: "bot",
      });
      await ctx.db.sql`update memories set embedding_ready = true where id = ${m.id}`;
      await new Promise((r) => setTimeout(r, 5));
      const updated = await updateMemory(ctx.db, m.id, "Mora em Olinda.");
      expect(updated).toMatchObject({
        id: m.id,
        text: "Mora em Olinda.",
        layer: "profile",
        scope: "shared",
        createdBy: "bot",
        embeddingReady: false,
      });
      expect(updated?.createdAt).toEqual(m.createdAt);
      expect(updated?.updatedAt.getTime() ?? 0).toBeGreaterThan(m.updatedAt.getTime());
      await expect(updateMemory(ctx.db, m.id, " ")).rejects.toThrow(/blank/);
      expect(await updateMemory(ctx.db, UNKNOWN, "x")).toBeNull();
      // the search index follows the text
      expect(await searchMemories(ctx.db, { query: "Olinda", limit: 5 })).toHaveLength(1);
      expect(await searchMemories(ctx.db, { query: "Recife", limit: 5 })).toHaveLength(0);
    });

    it("archives (forgets) idempotently and restores", async () => {
      const m = await addMemory(ctx.db, {
        layer: "rule",
        text: "Nunca ligue para mim.",
        createdBy: "user",
      });
      const archived = await archiveMemory(ctx.db, m.id);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect((await archiveMemory(ctx.db, m.id))?.archivedAt).toEqual(archived?.archivedAt);
      expect(ids(await listMemories(ctx.db, { layer: "rule", limit: 100 }))).not.toContain(m.id);
      expect(
        ids(await listMemories(ctx.db, { layer: "rule", includeArchived: true, limit: 100 })),
      ).toContain(m.id);
      expect(await searchMemories(ctx.db, { query: "ligue", limit: 5 })).toEqual([]);

      const restored = await restoreMemory(ctx.db, m.id);
      expect(restored?.archivedAt).toBeNull();
      expect(ids(await listMemories(ctx.db, { layer: "rule", limit: 100 }))).toContain(m.id);
      expect(await searchMemories(ctx.db, { query: "ligue", limit: 5 })).toHaveLength(1);
      expect(await archiveMemory(ctx.db, UNKNOWN)).toBeNull();
      expect(await restoreMemory(ctx.db, UNKNOWN)).toBeNull();
    });
  });

  describe("listing", () => {
    it("filters by layer, scope and bot, oldest first, with a limit", async () => {
      const [a, b] = [await newBot("la"), await newBot("lb")];
      const n1 = await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "L1",
        createdBy: "bot",
      });
      const n2 = await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "L2",
        createdBy: "bot",
      });
      const nb = await addMemory(ctx.db, {
        layer: "note",
        botId: b.id,
        text: "LB",
        createdBy: "bot",
      });
      const j = await addMemory(ctx.db, {
        layer: "journal",
        botId: a.id,
        text: "LJ",
        createdBy: "bot",
      });
      const p = await addMemory(ctx.db, { layer: "profile", text: "LP", createdBy: "user" });

      expect(ids(await listMemories(ctx.db, { botId: a.id, limit: 100 }))).toEqual([
        n1.id,
        n2.id,
        j.id,
      ]);
      expect(ids(await listMemories(ctx.db, { botId: a.id, layer: "note", limit: 100 }))).toEqual([
        n1.id,
        n2.id,
      ]);
      expect(ids(await listMemories(ctx.db, { botId: a.id, layer: "note", limit: 1 }))).toEqual([
        n1.id,
      ]);
      expect(ids(await listMemories(ctx.db, { botId: b.id, limit: 100 }))).toEqual([nb.id]);
      const shared = ids(await listMemories(ctx.db, { scope: "shared", limit: 1000 }));
      expect(shared).toContain(p.id);
      expect(shared).not.toContain(n1.id);
      await expect(listMemories(ctx.db, { limit: 0 })).rejects.toThrow();
    });
  });

  describe("visibility and search", () => {
    it("never lets a bot see another bot's notes; both see the shared ones", async () => {
      const [a, b] = [await newBot("va"), await newBot("vb")];
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "segredo do cometa azul",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "journal",
        botId: b.id,
        text: "diário do cometa verde",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "profile",
        text: "O cometa Halley é favorito.",
        createdBy: "user",
      });
      await addMemory(ctx.db, {
        layer: "rule",
        botId: b.id,
        text: "regra do cometa só do B",
        createdBy: "user",
      });

      const found = async (q: string, botId?: string) =>
        (await searchMemories(ctx.db, { query: q, limit: 20, ...(botId ? { botId } : {}) }))
          .map((h) => h.memory.text)
          .sort();

      expect(await found("cometa", a.id)).toEqual([
        "O cometa Halley é favorito.",
        "segredo do cometa azul",
      ]);
      expect(await found("cometa", b.id)).toEqual([
        "O cometa Halley é favorito.",
        "diário do cometa verde",
        "regra do cometa só do B",
      ]);
      // without a bot: shared only, never someone's notes
      expect(await found("cometa")).toEqual(["O cometa Halley é favorito."]);
      expect(await found("cometa", UNKNOWN)).toEqual(["O cometa Halley é favorito."]);
    });

    it("filters by layers", async () => {
      const a = await newBot("fa");
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "pitaya vermelha",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "journal",
        botId: a.id,
        text: "comprou pitaya",
        createdBy: "bot",
      });
      await addMemory(ctx.db, { layer: "profile", text: "gosta de pitaya", createdBy: "user" });
      const hits = (layers?: Memory["layer"][]) =>
        searchMemories(ctx.db, {
          query: "pitaya",
          botId: a.id,
          limit: 10,
          ...(layers ? { layers } : {}),
        });
      expect(await hits()).toHaveLength(3);
      expect((await hits(["note", "journal"])).map((h) => h.memory.layer).sort()).toEqual([
        "journal",
        "note",
      ]);
      expect(await hits([])).toEqual([]);
    });

    it("ranks by relevance, with an excerpt, stemming and accents", async () => {
      const a = await newBot("ra");
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "A faculdade fica longe. Vou de ônibus às vezes, mas prefiro uma carona.",
        createdBy: "bot",
      });
      const strong = await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "Ônibus, ônibus e mais ônibus: o ônibus 303 é o único.",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "Nada a ver.",
        createdBy: "bot",
      });
      const hits = await searchMemories(ctx.db, { query: "ônibus", botId: a.id, limit: 10 });
      expect(hits).toHaveLength(2);
      expect(hits[0]?.memory.id).toBe(strong.id);
      expect(hits[0]?.rank ?? 0).toBeGreaterThan(hits[1]?.rank ?? 1);
      expect(hits[0]?.excerpt).toContain(HIGHLIGHT_START);
      expect(hits[0]?.excerpt).toContain(HIGHLIGHT_END);
      expect(
        hits[1]?.excerpt.replaceAll(HIGHLIGHT_START, "[").replaceAll(HIGHLIGHT_END, "]"),
      ).toContain("[ônibus]");
      expect(
        await searchMemories(ctx.db, { query: "carona caronas", botId: a.id, limit: 10 }),
      ).toHaveLength(1);
      expect(await searchMemories(ctx.db, { query: "ônibus", botId: a.id, limit: 1 })).toHaveLength(
        1,
      );
    });

    it("never errors on hostile queries and returns [] without searchable terms", async () => {
      const a = await newBot("ha");
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "gosta de café sem açúcar",
        createdBy: "bot",
      });
      for (const query of [
        "",
        '"',
        "'; drop table memories; --",
        "café & | ! (",
        "a e o de",
        ":*",
        "\\",
        "\u0000café",
        "-café",
      ]) {
        await expect(
          searchMemories(ctx.db, { query, botId: a.id, limit: 5 }),
        ).resolves.toBeDefined();
      }
      expect(await searchMemories(ctx.db, { query: "a e o de", botId: a.id, limit: 5 })).toEqual(
        [],
      );
      expect(await searchMemories(ctx.db, { query: "", botId: a.id, limit: 5 })).toEqual([]);
      expect(
        await searchMemories(ctx.db, { query: '"café sem açúcar"', botId: a.id, limit: 5 }),
      ).toHaveLength(1);
      expect(
        await searchMemories(ctx.db, { query: "café -açúcar", botId: a.id, limit: 5 }),
      ).toEqual([]);
    });
  });

  describe("memoryContextFor", () => {
    it("returns the shared rules, the bot's own rules and the shared profile, in a stable order", async () => {
      const [a, b] = [await newBot("ca"), await newBot("cb")];
      const r1 = await addMemory(ctx.db, {
        layer: "rule",
        text: "ctx regra 1 compartilhada",
        createdBy: "user",
      });
      const ra = await addMemory(ctx.db, {
        layer: "rule",
        botId: a.id,
        text: "ctx regra de A",
        createdBy: "user",
      });
      const p1 = await addMemory(ctx.db, {
        layer: "profile",
        text: "ctx perfil 1",
        createdBy: "user",
      });
      const rb = await addMemory(ctx.db, {
        layer: "rule",
        botId: b.id,
        text: "ctx regra de B",
        createdBy: "user",
      });
      const r2 = await addMemory(ctx.db, {
        layer: "rule",
        text: "ctx regra 2 compartilhada",
        createdBy: "bot",
      });
      const p2 = await addMemory(ctx.db, {
        layer: "profile",
        text: "ctx perfil 2",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "note",
        botId: a.id,
        text: "ctx nota de A",
        createdBy: "bot",
      });
      await addMemory(ctx.db, {
        layer: "journal",
        botId: a.id,
        text: "ctx diário de A",
        createdBy: "bot",
      });
      const gone = await addMemory(ctx.db, {
        layer: "rule",
        text: "ctx regra esquecida",
        createdBy: "user",
      });
      await archiveMemory(ctx.db, gone.id);

      const forA = await memoryContextFor(ctx.db, a.id);
      const mine = (ms: Memory[]) => ms.filter((m) => m.text.startsWith("ctx "));
      expect(ids(mine(forA.rules))).toEqual([r1.id, ra.id, r2.id]);
      expect(ids(mine(forA.profile))).toEqual([p1.id, p2.id]);
      const forB = await memoryContextFor(ctx.db, b.id);
      expect(ids(mine(forB.rules))).toEqual([r1.id, rb.id, r2.id]);
      expect(ids(mine(forB.profile))).toEqual([p1.id, p2.id]);

      // Identical result (same order) on every call: the injected text is cache-friendly.
      expect(await memoryContextFor(ctx.db, a.id)).toEqual(forA);
      expect(texts(forA.rules)).toEqual([...texts(forA.rules)]);

      // Editing a memory does not reorder; forgetting removes it; restoring puts it back in place.
      await updateMemory(ctx.db, r1.id, "ctx regra 1 editada");
      expect(ids(mine((await memoryContextFor(ctx.db, a.id)).rules))).toEqual([
        r1.id,
        ra.id,
        r2.id,
      ]);
      await archiveMemory(ctx.db, ra.id);
      expect(ids(mine((await memoryContextFor(ctx.db, a.id)).rules))).toEqual([r1.id, r2.id]);
      await restoreMemory(ctx.db, ra.id);
      expect(ids(mine((await memoryContextFor(ctx.db, a.id)).rules))).toEqual([
        r1.id,
        ra.id,
        r2.id,
      ]);
    });

    it("orders memories created in the same instant by id", async () => {
      const a = await newBot("same");
      await ctx.db.sql`
        insert into memories (layer, scope, text, created_by, created_at)
        select 'rule', 'shared', 'same-' || i, 'user', '2030-01-01T00:00:00Z'
        from generate_series(1, 5) i`;
      const got = (await memoryContextFor(ctx.db, a.id)).rules.filter((m) =>
        m.text.startsWith("same-"),
      );
      expect(got).toHaveLength(5);
      expect(ids(got)).toEqual([...ids(got)].sort());
    });

    it("is empty for a bot with nothing relevant", async () => {
      const ctx2 = await memoryContextFor(ctx.db, UNKNOWN);
      expect(ctx2.rules.every((m) => m.scope === "shared")).toBe(true);
      expect(ctx2.profile.every((m) => m.scope === "shared")).toBe(true);
    });
  });
});
