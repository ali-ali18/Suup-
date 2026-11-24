import { createSearch, type DirectEngine, searchCacheKey } from "@suup/web";
import { describe, expect, it } from "vitest";
import { dbSearchCache } from "../src/web/search-cache.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

const wikipedia = (onAsk: () => void): DirectEngine => ({
  id: "wikipedia",
  async search() {
    onAsk();
    return {
      ok: true,
      hits: [{ url: "https://a.example/1", title: "One", snippet: "c", engine: "wikipedia" }],
    };
  },
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("web search cache in the database"), () => {
  const ctx = useIsolatedDb();

  it("survives a restart: a new search object over the same database answers from the cache, until it expires", async () => {
    let now = 1_700_000_000_000;
    let asked = 0;
    const engine = wikipedia(() => {
      asked++;
    });
    const make = () =>
      createSearch({
        direct: [engine],
        engines: ["wikipedia"],
        cache: dbSearchCache(() => ctx.db),
        cacheTtlMs: 60_000,
        now: () => now,
      });
    const first = await make()({ query: "Some  Words" });
    expect(first).toMatchObject({ ok: true });
    now += 30_000;
    // A "restarted" process: nothing in memory, the same database.
    const again = await make()({ query: "some words" });
    expect(again).toMatchObject({ ok: true, cached: { ageSeconds: 30 } });
    expect(asked).toBe(1);
    now += 31_000;
    expect(await make()({ query: "some words" })).toMatchObject({ ok: true });
    expect(asked).toBe(2);
    expect(searchCacheKey({ query: "some words", engines: ["wikipedia"] })).toContain("some words");
  });

  it("an entry that is not what this version writes is a miss, not an error", async () => {
    const cache = dbSearchCache(() => ctx.db);
    await ctx.db.sql`insert into web_search_cache (key, entry, stored_at, expires_at)
      values ('old', '{"hits": "nope"}'::jsonb, now(), now() + interval '1 hour')`;
    expect(await cache.get("old", Date.now())).toBeUndefined();
  });
});
