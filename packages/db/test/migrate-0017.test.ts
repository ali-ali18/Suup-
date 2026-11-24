import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addMemory,
  getMemorySettings,
  listChanges,
  listMemories,
  MIGRATIONS_DIR,
  memoryContextFor,
  migrate,
  searchMemories,
  touchMemories,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0017: nothing that existed changes meaning (every old memory is active, still found by
// the search, still in the context), the settings start at the owner's numbers, and the app is told
// of what waits for it, but not of a memory merely being used.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0017: memory consolidation"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("keeps the memories of before as active, searchable and loaded, and adds the new tables empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0017" && f.endsWith(".sql"));
    expect(held).toEqual([
      "0017_memory_consolidation.sql",
      "0018_search_any_word.sql",
      "0019_waiting_timer.sql",
      "0020_memory_prompt_limit_items.sql",
      "0021_stale_approvals.sql",
      "0022_reception.sql",
      "0023_supervisor.sql",
      "0024_web_search_cache.sql",
      "0025_bot_avatar_style.sql",
      "0026_routines.sql",
      "0027_message_routine_ref.sql",
      "0028_connector_oauth_catalog.sql",
      "0029_routine_reminders.sql",
      "0030_files.sql",
      "0031_web_search_usage.sql",
    ]);
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);

    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
    await ctx.db.sql`
      insert into memories (layer, scope, text, created_by) values
      ('rule', 'shared', 'Responda   em PORTUGUÊS.', 'user'),
      ('profile', 'shared', 'Mora em Recife.', 'user')`;
    await ctx.db.sql`
      insert into memories (layer, scope, bot_id, text, created_by)
      values ('note', 'bot', ${bot?.id as string}, 'O deploy fica em tools/deploy.sh', 'bot')`;

    expect(await migrate(ctx.db)).toEqual(held);

    const all = await listMemories(ctx.db, { limit: 50 });
    // (created in one statement: the order among them is not defined)
    expect(all.map((m) => [m.layer, m.status, m.summary, m.lastUsedAt]).sort()).toEqual([
      ["note", "active", null, null],
      ["profile", "active", null, null],
      ["rule", "active", null, null],
    ]);
    const context = await memoryContextFor(ctx.db, bot?.id as string);
    expect(context.rules.map((m) => m.text)).toEqual(["Responda   em PORTUGUÊS."]);
    expect(context.profile).toHaveLength(1);
    expect(context.omitted).toEqual({ count: 0, chars: 0 });
    // the text key of the old rows is the text without the difference of case and white space
    const [key] = await ctx.db.sql<{ text_key: string }[]>`
      select text_key from memories where layer = 'rule'`;
    expect(key?.text_key).toBe("responda em português.");
    expect(
      (await searchMemories(ctx.db, { query: "deploy", botId: bot?.id as string, limit: 5 }))
        .length,
    ).toBe(1);
    expect((await searchMemories(ctx.db, { query: "recife", limit: 5 })).length).toBe(1);

    // The settings start at the owner's numbers; there is nothing to consolidate or review yet.
    expect(await getMemorySettings(ctx.db)).toMatchObject({
      consolidationEnabled: true,
      idleMinutes: 5,
      maxTurns: 15,
      promptLimitItems: 200,
      expiryDays: 90,
      compactionThreshold: 0.8,
    });
    for (const table of ["memory_consolidations", "memory_reviews"]) {
      const [row] = await ctx.db.sql<
        { n: string }[]
      >`select count(*) as n from ${ctx.db.sql(table)}`;
      expect(row?.n).toBe("0");
    }
    expect(await migrate(ctx.db)).toEqual([]);
  });

  it("the change log tells the app about a pending memory and an edit, never about a memory being used", async () => {
    const [bot] = await ctx.db.sql<{ id: string }[]>`select id from bots limit 1`;
    const before = (await listChanges(ctx.db, 0, 10_000)).at(-1)?.id ?? 0;
    const note = await addMemory(ctx.db, {
      layer: "note",
      botId: bot?.id as string,
      text: "Uma nota nova.",
      createdBy: "bot",
    });
    const pending = await addMemory(ctx.db, {
      layer: "rule",
      text: "Uma regra pendente.",
      createdBy: "bot",
      status: "pending",
    });
    await touchMemories(ctx.db, [note.id]);
    await touchMemories(ctx.db, [note.id, pending.id]);
    const changes = (await listChanges(ctx.db, before, 100)).filter((c) => c.kind === "memory");
    expect(changes.map((c) => [c.ref === note.id ? "note" : "rule", c.op])).toEqual([
      ["note", "created"],
      ["rule", "pending"],
    ]);
    // using a memory is not an edit: the date of the last edit stays
    const [row] = await ctx.db.sql<
      { updated_at: Date; created_at: Date }[]
    >`select updated_at, created_at from memories where id = ${note.id}`;
    expect(row?.updated_at.getTime()).toBe(note.updatedAt.getTime());
  });
});
