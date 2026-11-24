// Owns the count of searches each general web engine answered in a month, in the database (table
// `web_search_usage`), so Settings can show it and it survives a restart. Only a number per engine
// and month: the query is never here. What the month is (UTC, `2026-11`) is `@suup/web`'s.
import { type Db, getWebSearchUsage, recordWebSearchUsage } from "@suup/db";
import { monthKey, type SearchUsage } from "@suup/web";

export function dbSearchUsage(db: () => Db): SearchUsage {
  return {
    async record(engine, at) {
      await recordWebSearchUsage(db(), engine, monthKey(at));
    },
    async month(at) {
      return await getWebSearchUsage(db(), monthKey(at));
    },
  };
}
