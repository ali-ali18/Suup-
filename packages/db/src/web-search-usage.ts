// Owns the count of searches each general web engine answered in a month (table
// `web_search_usage`, migration 0031). Only a number per engine and month: never the query, never a
// result. The month is written by `@suup/web` (`2026-11`); this module keeps what it is given.
import type { Db } from "./client.js";

/** One more search answered by the engine in the month. */
export async function recordWebSearchUsage(db: Db, engine: string, month: string): Promise<void> {
  await db.sql`
    insert into web_search_usage (engine, month, searches) values (${engine}, ${month}, 1)
    on conflict (engine, month) do update set searches = web_search_usage.searches + 1`;
}

/** The searches answered in the month, by engine (an engine with none is absent). */
export async function getWebSearchUsage(db: Db, month: string): Promise<Record<string, number>> {
  const rows = await db.sql<{ engine: string; searches: number }[]>`
    select engine, searches from web_search_usage where month = ${month}`;
  return Object.fromEntries(rows.map((row) => [row.engine, row.searches]));
}
