// Owns the cache of web searches in the database (table `web_search_cache`), so that an identical
// search made a little while ago is answered after a restart too, and for the worker and the app
// alike. What an entry means (key, validity, what is shown) is `@suup/web`'s; this only keeps it.
import { type Db, getWebSearchCache, putWebSearchCache } from "@suup/db";
import type { SearchCache, SearchCacheEntry } from "@suup/web";
import { z } from "zod";

const entrySchema = z.object({
  query: z.string(),
  engines: z.array(z.string()),
  hits: z.array(
    z.object({ title: z.string(), url: z.string(), snippet: z.string(), engine: z.string() }),
  ),
  suspended: z.array(z.object({ engine: z.string(), reason: z.string() })),
  storedAt: z.number(),
});

export function dbSearchCache(db: () => Db): SearchCache {
  return {
    async get(key, now) {
      const row = await getWebSearchCache(db(), key, new Date(now));
      if (row === undefined) return undefined;
      // An entry that is not what this version writes (an older one, a damaged one) is a miss.
      const parsed = entrySchema.safeParse(row.entry);
      return parsed.success ? (parsed.data satisfies SearchCacheEntry) : undefined;
    },
    async set(key, entry, ttlMs) {
      await putWebSearchCache(
        db(),
        key,
        entry,
        new Date(entry.storedAt),
        new Date(entry.storedAt + ttlMs),
      );
    },
  };
}
