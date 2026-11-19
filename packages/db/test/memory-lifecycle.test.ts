import { describe, expect, it } from "vitest";
import {
  addMemory,
  appendMessage,
  archiveMemory,
  type Bot,
  confirmMemory,
  createBot,
  createDirectConversation,
  expireUnusedMemories,
  findMemoriesWithText,
  getMemory,
  getMemorySettings,
  listMemories,
  listMemoryRevisions,
  MEMORY_SETTING_DEFAULTS,
  memoryContextFor,
  memoryPromptUsage,
  promoteToProfile,
  RevisionError,
  rejectMemory,
  restoreMemory,
  searchMemories,
  touchMemories,
  undoMemoryRevision,
  updateMemory,
  updateMemorySettings,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("memory lifecycle (migration 0017)"), () => {
  const ctx = useIsolatedDb();
  const newBot = (name = "bot"): Promise<Bot> =>
    createBot(ctx.db, { name, modelProvider: "fake", modelId: "fake-1" });

  it("starts with the owner's settings and validates every range", async () => {
    const settings = await getMemorySettings(ctx.db);
    expect(settings).toMatchObject(MEMORY_SETTING_DEFAULTS);
    expect(MEMORY_SETTING_DEFAULTS).toEqual({
      consolidationEnabled: true,
      idleMinutes: 5,
      maxTurns: 15,
      promptLimitChars: 6000,
      expiryDays: 90,
      compactionThreshold: 0.8,
    });
    const changed = await updateMemorySettings(ctx.db, { maxTurns: 20, expiryDays: null });
    expect(changed).toMatchObject({ maxTurns: 20, expiryDays: null, idleMinutes: 5 });
    await expect(updateMemorySettings(ctx.db, { idleMinutes: 0 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { idleMinutes: 121 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { maxTurns: 2 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { promptLimitChars: 999 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { expiryDays: 6 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { compactionThreshold: 0.49 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { compactionThreshold: 0.96 })).rejects.toThrow();
    await expect(updateMemorySettings(ctx.db, { surprise: 1 } as never)).rejects.toThrow();
    await updateMemorySettings(ctx.db, {
      ...MEMORY_SETTING_DEFAULTS,
    });
    expect((await getMemorySettings(ctx.db)).expiryDays).toBe(90);
  });

  it("keeps pending and rejected memories out of the prompt, the lists and the search", async () => {
    const bot = await newBot();
    const active = await addMemory(ctx.db, {
      layer: "rule",
      text: "Responda em português.",
      createdBy: "user",
    });
    const pending = await addMemory(ctx.db, {
      layer: "rule",
      text: "Sempre chame o usuário de senhor.",
      createdBy: "bot",
      status: "pending",
    });
    const ctxMem = await memoryContextFor(ctx.db, bot.id);
    expect(ctxMem.rules.map((m) => m.id)).toEqual([active.id]);
    expect((await listMemories(ctx.db, { limit: 50 })).map((m) => m.id)).not.toContain(pending.id);
    expect((await listMemories(ctx.db, { limit: 50, status: "pending" })).map((m) => m.id)).toEqual(
      [pending.id],
    );
    expect(await searchMemories(ctx.db, { query: "senhor", botId: bot.id, limit: 5 })).toEqual([]);

    const confirmed = await confirmMemory(ctx.db, pending.id);
    expect(confirmed?.status).toBe("active");
    expect((await memoryContextFor(ctx.db, bot.id)).rules).toHaveLength(2);

    const other = await addMemory(ctx.db, {
      layer: "profile",
      text: "Mora em Recife.",
      createdBy: "bot",
      status: "pending",
    });
    const rejected = await rejectMemory(ctx.db, other.id);
    expect(rejected?.status).toBe("rejected");
    expect((await memoryContextFor(ctx.db, bot.id)).profile).toEqual([]);
    // a confirmed memory cannot be "rejected" later, and a journal entry cannot wait
    expect((await rejectMemory(ctx.db, pending.id))?.status).toBe("active");
    await expect(
      addMemory(ctx.db, {
        layer: "journal",
        text: "x y z",
        botId: bot.id,
        createdBy: "bot",
        status: "pending",
      }),
    ).rejects.toThrow();
  });

  it("caps what always enters the prompt, in creation order, and counts what was left out", async () => {
    const bot = await newBot("capped");
    const made: string[] = [];
    for (const text of ["a".repeat(400), "b".repeat(400), "c".repeat(400), "d".repeat(10)]) {
      made.push(
        (await addMemory(ctx.db, { layer: "rule", text, botId: bot.id, createdBy: "user" })).id,
      );
    }
    const before = await memoryContextFor(ctx.db, bot.id);
    const all = before.rules.length;
    expect(before.omitted).toEqual({ count: 0, chars: 0 });
    const cap = before.totalChars - 400 - 10 + 1; // leaves out the last two of the bot's four
    const capped = await memoryContextFor(ctx.db, bot.id, { limitChars: cap });
    expect(capped.rules.length).toBe(all - 2);
    expect(capped.omitted).toEqual({ count: 2, chars: 410 });
    expect(capped.rules.map((m) => m.id)).not.toContain(made[3]);
    // creation order: it stops at the first that does not fit, never skips ahead
    const tiny = await memoryContextFor(ctx.db, bot.id, { limitChars: 1000 });
    const kept = tiny.rules.reduce((n, m) => n + m.text.length, 0);
    expect(kept).toBeLessThanOrEqual(1000);

    const usage = await memoryPromptUsage(ctx.db, 1000);
    expect(usage.overBots.map((b) => b.botId)).toContain(bot.id);
    const roomy = await memoryPromptUsage(ctx.db, 50_000);
    expect(roomy.overBots).toEqual([]);
  });

  it("indexes the short fact with the text and ranks a summary hit first", async () => {
    const bot = await newBot("fts");
    const withSummary = await addMemory(ctx.db, {
      layer: "note",
      botId: bot.id,
      text: "Na conversa de terça combinamos várias coisas sobre o projeto da horta, incluindo prazos e compras.",
      summary: "Orçamento da reforma: R$ 4.000",
      createdBy: "bot",
    });
    await addMemory(ctx.db, {
      layer: "note",
      botId: bot.id,
      text: "A reforma da cozinha foi mencionada de passagem; falaram do orçamento em outro momento.",
      createdBy: "bot",
    });
    const hits = await searchMemories(ctx.db, {
      query: "orçamento reforma",
      botId: bot.id,
      limit: 5,
    });
    expect(hits[0]?.memory.id).toBe(withSummary.id);
    // the summary alone is searchable
    expect(
      (await searchMemories(ctx.db, { query: "4.000", botId: bot.id, limit: 5 })).map(
        (h) => h.memory.id,
      ),
    ).toContain(withSummary.id);
    await expect(
      addMemory(ctx.db, {
        layer: "note",
        botId: bot.id,
        text: "x y z",
        summary: "s".repeat(201),
        createdBy: "bot",
      }),
    ).rejects.toThrow();
  });

  it("records every change and undoes the latest one only", async () => {
    const bot = await newBot("revs");
    const conv = await createDirectConversation(ctx.db, bot.id);
    const msg = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "user",
      text: "oi",
    });
    const note = await addMemory(ctx.db, {
      layer: "note",
      botId: bot.id,
      text: "O deploy fica em tools/deploy.sh",
      createdBy: "bot",
      actor: "consolidation",
      sourceConversationId: conv.id,
      sourceMessageId: msg.id,
    });
    await updateMemory(ctx.db, note.id, "O deploy fica em scripts/deploy.sh", { actor: "user" });
    await updateMemory(ctx.db, note.id, "O deploy fica em scripts/deploy.sh"); // no change: no revision
    await archiveMemory(ctx.db, note.id, { actor: "user" });
    await archiveMemory(ctx.db, note.id); // again: nothing
    const history = await listMemoryRevisions(ctx.db, note.id);
    expect(history.map((h) => [h.kind, h.actor])).toEqual([
      ["archived", "user"],
      ["edited", "user"],
      ["created", "consolidation"],
    ]);
    expect(history[2]?.originConversationId).toBe(conv.id);
    expect(history[2]?.originMessageId).toBe(msg.id);
    expect(history[1]?.prev?.text).toBe("O deploy fica em tools/deploy.sh");
    expect(history[1]?.next.text).toBe("O deploy fica em scripts/deploy.sh");

    // only the latest can be undone
    await expect(
      undoMemoryRevision(ctx.db, (history[1] as { id: string }).id),
    ).rejects.toBeInstanceOf(RevisionError);
    const restored = await undoMemoryRevision(ctx.db, (history[0] as { id: string }).id);
    expect(restored.archivedAt).toBeNull();
    const back = await listMemoryRevisions(ctx.db, note.id);
    expect(back[0]?.kind).toBe("undone");
    const edited = await undoMemoryRevision(ctx.db, (back[0] as { id: string }).id); // undo the undo = redo
    expect(edited.archivedAt).not.toBeNull();
    // undoing a creation forgets the memory
    const fresh = await addMemory(ctx.db, {
      layer: "rule",
      text: "Seja breve.",
      createdBy: "user",
    });
    const [created] = await listMemoryRevisions(ctx.db, fresh.id);
    const gone = await undoMemoryRevision(ctx.db, (created as { id: string }).id);
    expect(gone.archivedAt).not.toBeNull();
    await expect(
      undoMemoryRevision(ctx.db, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(RevisionError);
  });

  it("promotes a note to a shared profile fact and the undo brings the note back", async () => {
    const bot = await newBot("promo");
    const note = await addMemory(ctx.db, {
      layer: "note",
      botId: bot.id,
      text: "Mora em Recife",
      createdBy: "bot",
    });
    const promoted = await promoteToProfile(ctx.db, note.id, { actor: "consolidation" });
    expect(promoted).toMatchObject({
      layer: "profile",
      scope: "shared",
      botId: null,
      status: "active",
    });
    // not a note or a pending profile: nothing happens
    expect((await promoteToProfile(ctx.db, note.id))?.layer).toBe("profile");
    const [latest] = await listMemoryRevisions(ctx.db, note.id);
    expect(latest?.kind).toBe("promoted");
    const undone = await undoMemoryRevision(ctx.db, (latest as { id: string }).id);
    expect(undone).toMatchObject({ layer: "note", scope: "bot", botId: bot.id });
  });

  it("finds a fact by exact text, ignoring only case and white space", async () => {
    const bot = await newBot("keys");
    const m = await addMemory(ctx.db, {
      layer: "note",
      botId: bot.id,
      text: "Vive   em\nCaruaru",
      createdBy: "bot",
    });
    expect((await findMemoriesWithText(ctx.db, "  vive em caruaru ")).map((x) => x.id)).toContain(
      m.id,
    );
    expect(await findMemoriesWithText(ctx.db, "Vive em Caruaru, PE")).toEqual([]);
    await updateMemory(ctx.db, m.id, "Vive em Olinda");
    expect(await findMemoriesWithText(ctx.db, "vive em caruaru")).toEqual([]);
    expect((await findMemoriesWithText(ctx.db, "VIVE EM OLINDA")).map((x) => x.id)).toContain(m.id);
  });

  it("expires unused notes and journal entries, renews on use, never touches rules or the profile", async () => {
    const bot = await newBot("expiry");
    const mk = (layer: "note" | "rule" | "profile", text: string) =>
      addMemory(ctx.db, {
        layer,
        text,
        ...(layer === "note" ? { botId: bot.id } : {}),
        createdBy: "bot",
      });
    const oldNote = await mk("note", "Nota velha sem uso");
    const usedNote = await mk("note", "Nota velha mas usada");
    const rule = await mk("rule", "Regra velha");
    const profile = await mk("profile", "Fato velho");
    const young = await mk("note", "Nota nova");
    const longAgo = new Date(Date.now() - 100 * 86_400_000);
    await ctx.db
      .sql`update memories set created_at = ${longAgo} where id in (${oldNote.id}, ${usedNote.id}, ${rule.id}, ${profile.id})`;
    await touchMemories(ctx.db, [usedNote.id]);

    const expired = await expireUnusedMemories(ctx.db, { days: 90 });
    expect(expired.map((m) => m.id)).toEqual([oldNote.id]);
    for (const id of [usedNote.id, rule.id, profile.id, young.id]) {
      expect((await getMemory(ctx.db, id))?.archivedAt).toBeNull();
    }
    const [rev] = await listMemoryRevisions(ctx.db, oldNote.id);
    expect(rev).toMatchObject({ kind: "archived", actor: "expiry" });
    // restorable
    expect((await restoreMemory(ctx.db, oldNote.id))?.archivedAt).toBeNull();
    // renewing did not count as an edit
    const used = await getMemory(ctx.db, usedNote.id);
    expect(used?.lastUsedAt).not.toBeNull();
    expect(used?.updatedAt.getTime()).toBe(usedNote.updatedAt.getTime());
    // a long time later, the renewal itself ages
    const future = new Date(Date.now() + 100 * 86_400_000);
    const again = await expireUnusedMemories(ctx.db, { days: 90, now: future });
    expect(again.map((m) => m.id)).toContain(usedNote.id);
    expect(again.map((m) => m.id)).not.toContain(rule.id);
  });
});
