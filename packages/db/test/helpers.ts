import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import { createDb, type Db, migrate } from "../src/index.js";

export const DATABASE_URL = process.env.DATABASE_URL;

/** Use as `describe.skipIf(!DATABASE_URL)(SKIP_NOTE ...)` titles so a skip says why. */
export const dbSuiteName = (name: string): string =>
  DATABASE_URL ? name : `${name} (skipped: DATABASE_URL is not set)`;

/**
 * Gives a test file its own Postgres schema, dropped afterwards, so files can run in parallel
 * against the same database. Call inside a `describe`; read `ctx.db` from the tests.
 */
export function useIsolatedDb(options: { migrate?: boolean } = {}): { db: Db; schema: string } {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const ctx = { db: undefined as unknown as Db, schema };
  let admin: postgres.Sql | undefined;

  beforeAll(async () => {
    const url = DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    admin = postgres(url, { max: 1, onnotice: false });
    await admin.unsafe(`create schema ${schema}`);
    ctx.db = createDb(url, { schema });
    if (options.migrate ?? true) await migrate(ctx.db);
  });

  afterAll(async () => {
    await ctx.db?.close();
    if (admin) {
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });

  return ctx;
}
