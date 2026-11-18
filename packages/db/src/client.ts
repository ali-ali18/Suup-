import postgres, { type Sql } from "postgres";

export interface CreateDbOptions {
  /**
   * Postgres schema to use (sets `search_path`). Migrations and queries are unqualified, so this
   * is how tests get an isolated copy of the tables. Default: the server's default (`public`).
   */
  schema?: string;
  /** Maximum pool size. Default: 10. */
  max?: number;
}

export interface Db {
  readonly sql: Sql;
  close(): Promise<void>;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createDb(url: string, opts: CreateDbOptions = {}): Db {
  if (opts.schema !== undefined && !SCHEMA_NAME.test(opts.schema)) {
    throw new Error(`Invalid schema name: ${JSON.stringify(opts.schema)}`);
  }
  const sql = postgres(url, {
    ...(opts.max !== undefined ? { max: opts.max } : {}),
    ...(opts.schema !== undefined ? { connection: { search_path: opts.schema } } : {}),
    onnotice: false,
  });
  return {
    sql,
    close: () => sql.end(),
  };
}
