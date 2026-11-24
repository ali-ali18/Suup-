import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSecrets, MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0032: a connector's login secrets already in the vault get marked as the connector's own
// (by exact name), lose their grants, and leave the owner's list; every other secret is untouched.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0032: secrets managed_by"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("marks exactly the names a connector produces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await rm(join(dir, "0032_secrets_managed_by.sql"));
    await migrate(ctx.db, dir);
    await ctx.db
      .sql`insert into connectors (name, transport, command) values ('my-notion', 'stdio', 'node')`;
    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
    for (const name of [
      "SUUP_OAUTH_MY_NOTION_ACCESS",
      "SUUP_OAUTH_MY_NOTION_CLIENT_SECRET",
      "SUUP_OAUTH_OTHER_ACCESS",
      "GITHUB_TOKEN",
    ]) {
      await ctx.db.sql`
        insert into secrets (name, nonce, ciphertext, key_id)
        values (${name}, ${Buffer.alloc(12)}, ${Buffer.alloc(20)}, 'k')`;
      await ctx.db.sql`
        insert into secret_grants (secret_id, bot_id)
        select id, ${bot?.id as string} from secrets where name = ${name}`;
    }

    expect(await migrate(ctx.db)).toEqual(["0032_secrets_managed_by.sql"]);

    expect((await listSecrets(ctx.db)).map((s) => s.name)).toEqual([
      "GITHUB_TOKEN",
      "SUUP_OAUTH_OTHER_ACCESS",
    ]);
    const all = await listSecrets(ctx.db, { includeManaged: true });
    expect(all.find((s) => s.name === "SUUP_OAUTH_MY_NOTION_ACCESS")).toMatchObject({
      managedBy: "my-notion",
      grantedBotIds: [],
    });
    expect(all.find((s) => s.name === "GITHUB_TOKEN")?.grantedBotIds).toHaveLength(1);
  });
});
