import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0035: the colour "grafite" left the palette; the bots that had it become "cinza", and
// every other colour (and a bot with none) is untouched.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0035: bot colour palette"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("moves grafite to cinza and leaves the rest alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await rm(join(dir, "0035_bot_color_palette.sql"));
    await migrate(ctx.db, dir);
    for (const [name, color] of [
      ["a", "grafite"],
      ["b", "azul"],
      ["c", null],
    ] as const) {
      await ctx.db.sql`
        insert into bots (name, model_provider, model_id, color) values (${name}, 'p', 'm', ${color})`;
    }

    expect(await migrate(ctx.db)).toEqual(["0035_bot_color_palette.sql"]);

    const rows = await ctx.db.sql<{ name: string; color: string | null }[]>`
      select name, color from bots order by name`;
    expect(rows).toEqual([
      { name: "a", color: "cinza" },
      { name: "b", color: "azul" },
      { name: "c", color: null },
    ]);
  });
});
