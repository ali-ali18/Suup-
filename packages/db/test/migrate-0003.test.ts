import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0003 on existing data"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("applies on top of 0001 + 0002 and keeps the rows that already exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    // Everything from 0003 on is held back (later migrations build on it).
    const later = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .slice(2);
    for (const file of later) await rm(join(dir, file));
    expect(await migrate(ctx.db, dir)).toEqual([
      "0001_init.sql",
      "0002_inbox_and_model_origin.sql",
    ]);

    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('old', 'p', 'm') returning id`;
    await ctx.db.sql`
      insert into runs (bot_id, origin, objective) values (${bot?.id ?? ""}, 'user', 'old run')`;

    expect(await migrate(ctx.db)).toEqual(later);

    const [b] = await ctx.db.sql<{ avatar: string | null; is_default: boolean }[]>`
      select avatar, is_default from bots`;
    expect(b).toEqual({ avatar: null, is_default: false });
    const [r] = await ctx.db.sql<{ conversation_id: string | null }[]>`
      select conversation_id from runs`;
    expect(r?.conversation_id).toBeNull();
  });
});
