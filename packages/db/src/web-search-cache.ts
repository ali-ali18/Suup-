// Owns the cache of web searches (table `web_search_cache`, migration 0024): the entry of a search
// that found something, by the key `@suup/web` builds, until it expires. It keeps what it is given
// and compares nothing but the key; what an entry means is `@suup/web`'s.
import type { Db } from "./client.js";

export interface WebSearchCacheRow {
  entry: unknown;
  storedAt: Date;
}

/** The entry under the key, unless it expired. */
export async function getWebSearchCache(
  db: Db,
  key: string,
  now: Date,
): Promise<WebSearchCacheRow | undefined> {
  const rows = await db.sql<{ entry: unknown; stored_at: Date }[]>`
    select entry, stored_at from web_search_cache where key = ${key} and expires_at > ${now}`;
  const row = rows[0];
  return row === undefined ? undefined : { entry: row.entry, storedAt: row.stored_at };
}

/** Keeps the entry (replacing the one under the key) until `expiresAt`, and sweeps the entries that expired. */
export async function putWebSearchCache(
  db: Db,
  key: string,
  entry: unknown,
  storedAt: Date,
  expiresAt: Date,
): Promise<void> {
  await db.sql`
    insert into web_search_cache (key, entry, stored_at, expires_at)
    values (${key}, ${db.sql.json(entry as never)}, ${storedAt}, ${expiresAt})
    on conflict (key) do update
      set entry = excluded.entry, stored_at = excluded.stored_at, expires_at = excluded.expires_at`;
  await db.sql`delete from web_search_cache where expires_at <= ${storedAt}`;
}

/** Empties the cache. Returns how many entries went. */
export async function clearWebSearchCache(db: Db): Promise<number> {
  const rows = await db.sql<{ key: string }[]>`delete from web_search_cache returning key`;
  return rows.length;
}
