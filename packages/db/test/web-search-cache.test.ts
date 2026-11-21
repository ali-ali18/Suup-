import { describe, expect, it } from "vitest";
import { clearWebSearchCache, getWebSearchCache, putWebSearchCache } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("web search cache (migration 0024)"), () => {
  const ctx = useIsolatedDb();
  const t0 = new Date("2026-11-21T10:00:00Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  it("keeps an entry until it expires, and gives it back whole", async () => {
    const entry = {
      query: "a b",
      hits: [{ url: "https://a.example/" }],
      suspended: [],
      engines: ["x"],
    };
    await putWebSearchCache(ctx.db, "k1", entry, t0, at(180));
    expect(await getWebSearchCache(ctx.db, "k1", at(179))).toEqual({ entry, storedAt: t0 });
    expect(await getWebSearchCache(ctx.db, "k1", at(180))).toBeUndefined();
    expect(await getWebSearchCache(ctx.db, "other", at(1))).toBeUndefined();
  });

  it("a new entry under the same key replaces the old one, and writing sweeps what expired", async () => {
    await putWebSearchCache(ctx.db, "k2", { n: 1 }, t0, at(10));
    await putWebSearchCache(ctx.db, "k2", { n: 2 }, at(5), at(100));
    expect((await getWebSearchCache(ctx.db, "k2", at(6)))?.entry).toEqual({ n: 2 });
    await putWebSearchCache(ctx.db, "k3", { n: 3 }, at(200), at(300));
    const rows = await ctx.db.sql<{ key: string }[]>`select key from web_search_cache order by key`;
    expect(rows.map((r) => r.key)).toEqual(["k3"]);
  });

  it("clears everything", async () => {
    await putWebSearchCache(ctx.db, "k4", { n: 4 }, at(300), at(400));
    expect(await clearWebSearchCache(ctx.db)).toBeGreaterThanOrEqual(1);
    expect(await getWebSearchCache(ctx.db, "k4", at(301))).toBeUndefined();
  });
});
