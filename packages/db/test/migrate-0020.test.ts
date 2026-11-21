import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMemorySettings, MIGRATIONS_DIR, migrate, updateMemorySettings } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0020: the cap of what always enters the prompt is counted in memories (default 200), not
// in characters. The old value cannot be converted, so any old number becomes the default; the other
// settings of the same row stay as they were.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0020: prompt limit in memories"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("turns any old character limit into 200 memories and keeps the rest of the row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0020" && f.endsWith(".sql"));
    expect(held).toEqual([
      "0020_memory_prompt_limit_items.sql",
      "0021_stale_approvals.sql",
      "0025_bot_avatar_style.sql",
    ]);
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);
    await ctx.db.sql`
      update memory_settings set prompt_limit_chars = 1500, max_turns = 30, expiry_days = null`;

    expect(await migrate(ctx.db)).toEqual(held);

    expect(await getMemorySettings(ctx.db)).toMatchObject({
      promptLimitItems: 200,
      maxTurns: 30,
      expiryDays: null,
    });
    const columns = await ctx.db.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${ctx.schema} and table_name = 'memory_settings'`;
    expect(columns.map((c) => c.column_name)).not.toContain("prompt_limit_chars");
    // the table keeps the range too, whatever the code says
    await expect(ctx.db.sql`update memory_settings set prompt_limit_items = 19`).rejects.toThrow();
    await expect(
      ctx.db.sql`update memory_settings set prompt_limit_items = 1001`,
    ).rejects.toThrow();
    expect((await updateMemorySettings(ctx.db, { promptLimitItems: 20 })).promptLimitItems).toBe(
      20,
    );
    expect(await migrate(ctx.db)).toEqual([]);
  });
});
