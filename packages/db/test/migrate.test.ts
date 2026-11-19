import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, MigrationChecksumError, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

/** The migration files of the package, in order: the tests do not hardcode how many there are. */
async function allMigrations(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
}

describe.skipIf(!DATABASE_URL)(dbSuiteName("migrate"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("finds the migrations directory next to src/", async () => {
    expect(await readdir(MIGRATIONS_DIR)).toContain("0001_init.sql");
  });

  it("applies pending migrations, records them, and is idempotent", async () => {
    const first = await migrate(ctx.db);
    expect(first).toEqual(await allMigrations());
    expect(first.slice(0, 3)).toEqual([
      "0001_init.sql",
      "0002_inbox_and_model_origin.sql",
      "0003_conversations_and_memory.sql",
    ]);

    const second = await migrate(ctx.db);
    expect(second).toEqual([]);

    const rows = await ctx.db.sql`select name, checksum from schema_migrations`;
    expect(rows.map((r) => r.name)).toEqual(await allMigrations());
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

    const tables = await ctx.db.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = ${ctx.schema} order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "approval_rules",
      "approvals",
      "bots",
      "change_log",
      "change_log_state",
      "connector_discovery",
      "connector_grants",
      "connector_pin_baselines",
      "connector_tool_events",
      "connector_tool_pins",
      "connectors",
      "conversation_members",
      "conversations",
      "memories",
      "messages",
      "run_events",
      "run_inbox",
      "runs",
      "schema_migrations",
      "secret_grants",
      "secrets",
    ]);
  });

  it("rejects an already applied migration whose contents changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await migrate(ctx.db, dir); // already applied with the original checksum: no-op

    const file = join(dir, "0001_init.sql");
    await writeFile(file, `${await readFile(file, "utf8")}\n-- tampered\n`);

    const error = await migrate(ctx.db, dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationChecksumError);
    expect((error as Error).message).toContain("0001_init.sql");
    expect((error as Error).message).toMatch(/changed/);
  });

  it("applies a new file added after the first run, each in its own transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await writeFile(join(dir, "0900_ok.sql"), "create table extra_ok (id int);\n");
    await writeFile(
      join(dir, "0901_broken.sql"),
      "create table extra_rolled_back (id int);\nselect no_such_function();\n",
    );

    await expect(migrate(ctx.db, dir)).rejects.toThrow(/0901_broken\.sql failed/);

    const names = await ctx.db.sql<{ name: string }[]>`select name from schema_migrations`;
    expect(names.map((n) => n.name).sort()).toEqual([...(await allMigrations()), "0900_ok.sql"]);
    const [t] = await ctx.db.sql<{ ok: string | null; rolled: string | null }[]>`
      select to_regclass('extra_ok')::text as ok, to_regclass('extra_rolled_back')::text as rolled`;
    expect(t?.ok).not.toBeNull();
    expect(t?.rolled).toBeNull();
  });

  it("serializes concurrent migrators with the advisory lock", async () => {
    const fresh = await ctx.db.sql`select 1`; // keep pool warm
    expect(fresh).toHaveLength(1);
    await ctx.db
      .sql`drop table schema_migrations, memories, messages, conversation_members, conversations, run_inbox, approvals, approval_rules, secret_grants, secrets, connector_discovery, connector_grants, connector_pin_baselines, connector_tool_events, connector_tool_pins, connectors, run_events, runs, bots, extra_ok, change_log, change_log_state cascade`;
    await ctx.db
      .sql`drop function set_updated_at(), run_events_append_only(), suup_search_query(text), suup_unaccent(text)`;
    const results = await Promise.all([migrate(ctx.db), migrate(ctx.db), migrate(ctx.db)]);
    expect(results.flat()).toEqual(await allMigrations());
  });
});
