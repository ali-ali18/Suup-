import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

/**
 * Migrations live in `<package root>/migrations`. This file sits one level below the package root
 * both in `src/` (tests) and in `dist/` (built), so the same relative path works for both.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;

export class MigrationChecksumError extends Error {
  constructor(
    readonly migration: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Migration ${migration} was already applied but its contents changed ` +
        `(applied checksum ${expected}, file checksum ${actual}). ` +
        "Applied migrations are immutable: add a new migration instead of editing this one.",
    );
    this.name = "MigrationChecksumError";
  }
}

interface MigrationFile {
  name: string;
  content: string;
  checksum: string;
}

async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => MIGRATION_FILE.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(dir, name), "utf8");
      return { name, content, checksum: createHash("sha256").update(content).digest("hex") };
    }),
  );
}

/**
 * Applies pending migrations in filename order, each in its own transaction. Returns the names
 * applied by this call (empty when already up to date). Throws `MigrationChecksumError` if an
 * applied file was modified, before applying anything.
 *
 * A session-level advisory lock (per schema) keeps two processes from migrating at once; the
 * second one waits and then finds nothing left to do.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await loadMigrationFiles(dir);
  // One dedicated connection: the advisory lock belongs to the session, and BEGIN/COMMIT must
  // all go through the same connection.
  const conn = await db.sql.reserve();
  try {
    await conn`select pg_advisory_lock(hashtextextended('suup:migrate:' || current_schema(), 0))`;
    try {
      await conn`
        create table if not exists schema_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`;
      const rows = await conn<{ name: string; checksum: string }[]>`
        select name, checksum from schema_migrations`;
      const applied = new Map(rows.map((r) => [r.name, r.checksum]));

      for (const file of files) {
        const recorded = applied.get(file.name);
        if (recorded !== undefined && recorded !== file.checksum) {
          throw new MigrationChecksumError(file.name, recorded, file.checksum);
        }
      }

      const done: string[] = [];
      for (const file of files) {
        if (applied.has(file.name)) continue;
        await conn.unsafe("begin");
        try {
          await conn.unsafe(file.content);
          await conn`insert into schema_migrations (name, checksum) values (${file.name}, ${file.checksum})`;
          await conn.unsafe("commit");
        } catch (error) {
          await conn.unsafe("rollback");
          throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
        done.push(file.name);
      }
      return done;
    } finally {
      await conn`select pg_advisory_unlock(hashtextextended('suup:migrate:' || current_schema(), 0))`;
    }
  } finally {
    conn.release();
  }
}
