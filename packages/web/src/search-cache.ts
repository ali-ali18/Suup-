// Owns the cache of web searches (docs/BUSCA.md, "Busca educada"): an identical search, asked again
// within the time to live, is answered from here instead of being sent to the engines again. The
// key is the query in a plain form (trimmed, blanks collapsed, lower case) plus the engines and the
// options that change what comes back. Where the entries live is a `SearchCache`: the process's
// memory here, the database in the runtime (so it survives a restart and is shared by the worker
// and the app).
import type { WebSearchHit } from "@suup/core";

/** What is kept of a search that found something. */
export interface SearchCacheEntry {
  query: string;
  engines: string[];
  hits: WebSearchHit[];
  /** Engines that did not answer when it was made (so a cached answer can say what it lacked). */
  suspended: { engine: string; reason: string }[];
  /** When it was made, in milliseconds since the epoch. */
  storedAt: number;
}

export interface SearchCache {
  /** The entry for the key, unless it has expired. */
  get(key: string, now: number): Promise<SearchCacheEntry | undefined>;
  set(key: string, entry: SearchCacheEntry, ttlMs: number): Promise<void>;
}

export const DEFAULT_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

/** The query in its plain form: no blank at the ends, runs of blanks as one space, lower case. No pattern: it is split at blanks and joined. */
export function normalizeQuery(query: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of query) {
    if (ch.trim() === "") {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word !== "") words.push(word);
  return words.join(" ").toLowerCase();
}

/** The key of a search: the plain query, the engines (sorted) and the options that change the answer. */
export function searchCacheKey(input: {
  query: string;
  engines: readonly string[];
  language?: string | undefined;
  timeRange?: string | undefined;
}): string {
  return JSON.stringify([
    normalizeQuery(input.query),
    [...input.engines].sort(),
    input.language ?? "",
    input.timeRange ?? "",
  ]);
}

/** A cache in the memory of the process: the oldest entry goes first when it is full. */
export function memorySearchCache(maxEntries = 200): SearchCache {
  const entries = new Map<string, { entry: SearchCacheEntry; expiresAt: number }>();
  return {
    async get(key, now) {
      const found = entries.get(key);
      if (found === undefined) return undefined;
      if (found.expiresAt <= now) {
        entries.delete(key);
        return undefined;
      }
      return structuredClone(found.entry);
    },
    async set(key, entry, ttlMs) {
      entries.delete(key);
      entries.set(key, { entry: structuredClone(entry), expiresAt: entry.storedAt + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}
