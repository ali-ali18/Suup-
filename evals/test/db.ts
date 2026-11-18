import { randomBytes } from "node:crypto";
import { createDb, type Db, migrate } from "@suup/db";
import { afterAll, beforeAll } from "vitest";

export const DATABASE_URL = process.env.DATABASE_URL;

export const dbSuiteName = (name: string): string =>
  DATABASE_URL ? name : `${name} (skipped: DATABASE_URL is not set)`;

/** One Postgres schema per test file, migrated and dropped afterwards. */
export function useIsolatedDb(): { db: Db; schema: string; url: string } {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const ctx = { db: undefined as unknown as Db, schema, url: "" };
  let admin: Db | undefined;

  beforeAll(async () => {
    const base = DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is not set");
    admin = createDb(base, { max: 1 });
    await admin.sql.unsafe(`create schema ${schema}`);
    const url = new URL(base);
    url.searchParams.set("search_path", schema);
    ctx.url = url.toString();
    ctx.db = createDb(base, { schema });
    await migrate(ctx.db);
  });

  afterAll(async () => {
    await ctx.db?.close();
    if (admin) {
      await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  return ctx;
}
