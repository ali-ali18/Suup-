import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSecrets, MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0036: each secret declares the hosts it may go to. The secrets that already exist keep
// everything they had and start WITHOUT hosts (blocked until the owner declares them); the ones a
// plugin keeps (`managed_by`) are not touched and use no list.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0036: secret hosts"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("keeps the existing secrets, blocked, and does not touch the plugin's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await rm(join(dir, "0036_secret_hosts.sql"));
    await migrate(ctx.db, dir);
    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
    for (const [name, managedBy] of [
      ["GITHUB_TOKEN", null],
      ["OLD_ONE", null],
      ["SUUP_OAUTH_NOTION_ACCESS", "notion"],
    ] as const) {
      await ctx.db.sql`
        insert into secrets (name, nonce, ciphertext, key_id, managed_by)
        values (${name}, ${Buffer.alloc(12)}, ${Buffer.alloc(20)}, 'k', ${managedBy})`;
    }
    await ctx.db.sql`
      insert into secret_grants (secret_id, bot_id)
      select id, ${bot?.id as string} from secrets where name = 'GITHUB_TOKEN'`;

    expect(await migrate(ctx.db)).toEqual(["0036_secret_hosts.sql"]);

    const all = await listSecrets(ctx.db, { includeManaged: true });
    expect(all.map((s) => [s.name, s.managedBy, s.hosts])).toEqual([
      ["GITHUB_TOKEN", null, []],
      ["OLD_ONE", null, []],
      ["SUUP_OAUTH_NOTION_ACCESS", "notion", []],
    ]);
    // Grants and the rest are exactly what they were.
    expect(all.find((s) => s.name === "GITHUB_TOKEN")?.grantedBotIds).toEqual([bot?.id]);
    const [count] = await ctx.db.sql<{ n: string }[]>`select count(*) as n from secret_hosts`;
    expect(Number(count?.n)).toBe(0);
  });
});
