// The politeness of the search (docs/BUSCA.md, "Busca educada"): rate limits with a queue, a cache,
// and what is said about engines that asked to be left alone. A fake clock: no test waits for real time.
import type { WebSearchOutcome } from "@suup/core";
import { describe, expect, it } from "vitest";
import type { DirectEngine, DirectSearchResult } from "../src/direct-engines.js";
import { createSearch } from "../src/search.js";
import { memorySearchCache, normalizeQuery, searchCacheKey } from "../src/search-cache.js";
import { SearchGovernor } from "../src/search-governor.js";
import { createWebAccess } from "../src/service.js";

class Clock {
  now = 1_700_000_000_000;
  slept: number[] = [];
  sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.now += ms;
  };
  advance(ms: number): void {
    this.now += ms;
  }
}

const hit = (id: string, n: number) => ({
  title: `${id} ${n}`,
  url: `https://${id}.example/${n}`,
  snippet: "c",
  engine: id,
});

/** An engine that answers what `reply` says, and counts how many times it was asked. */
function fake(
  id: string,
  reply: (call: number) => DirectSearchResult | Promise<DirectSearchResult>,
): DirectEngine & { calls: number } {
  const engine = {
    id,
    calls: 0,
    async search() {
      engine.calls += 1;
      return await reply(engine.calls);
    },
  };
  return engine;
}

const hits = (id: string, count = 1): DirectSearchResult => ({
  ok: true,
  hits: Array.from({ length: count }, (_, i) => hit(id, i + 1)),
});

const ok = (outcome: WebSearchOutcome) => {
  if (!outcome.ok) throw new Error(`expected a result: ${outcome.message}`);
  return outcome;
};

describe("normalizeQuery and the cache key", () => {
  it("trims, collapses blanks and lowercases, without a pattern", () => {
    expect(normalizeQuery("  Hello \t  WORLD\n again  ")).toBe("hello world again");
    expect(normalizeQuery("")).toBe("");
  });
  it("the same plain query and engines give the same key, in any order of engines; any other difference does not", () => {
    const base = { query: "Hello  World", engines: ["b", "a"] };
    expect(searchCacheKey(base)).toBe(
      searchCacheKey({ query: " hello world ", engines: ["a", "b"] }),
    );
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, engines: ["a"] }));
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, language: "pt" }));
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, timeRange: "day" }));
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, query: "hello world!" }));
  });
});

describe("rate limits", () => {
  it("lets searches through up to the limit, then waits in the queue for the first free moment", async () => {
    const clock = new Clock();
    const governor = new SearchGovernor({
      limits: { perMinute: 2, maxWaitMs: 60_000 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    const first = await governor.acquire(["wikipedia"]);
    clock.advance(10_000);
    const second = await governor.acquire(["wikipedia"]);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(clock.slept).toEqual([]);
    // The third goes out when the first leaves the 60 s window: 50 s from now.
    const third = await governor.acquire(["wikipedia"]);
    expect(third).toMatchObject({ ok: true, waitedMs: 50_000 });
    expect(clock.slept).toEqual([50_000]);
  });

  it("refuses with the time to try again when the wait would be longer than allowed, and does not take the slot", async () => {
    const clock = new Clock();
    const governor = new SearchGovernor({
      limits: { perMinute: 1, maxWaitMs: 5_000 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    await governor.acquire(["wikipedia"]);
    clock.advance(20_000);
    expect(await governor.acquire(["wikipedia"])).toEqual({
      ok: false,
      retryInSeconds: 40,
      scope: "overall",
    });
    expect(clock.slept).toEqual([]);
    clock.advance(40_000);
    expect(await governor.acquire(["wikipedia"])).toMatchObject({ ok: true });
  });

  it("applies a limit per engine: the engine over its own limit is left out while others go on", async () => {
    const clock = new Clock();
    const governor = new SearchGovernor({
      limits: { perMinute: 100, perEngine: { arxiv: 1 }, maxWaitMs: 1_000 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    expect(await governor.acquire(["wikipedia", "arxiv"])).toMatchObject({
      ok: true,
      engines: ["wikipedia", "arxiv"],
    });
    clock.advance(15_000);
    expect(await governor.acquire(["wikipedia", "arxiv"])).toEqual({
      ok: true,
      engines: ["wikipedia"],
      throttled: [{ engine: "arxiv", retryInSeconds: 45 }],
      waitedMs: 0,
    });
    // Only the engine that is over its limit: nothing to ask, so the time to come back.
    expect(await governor.acquire(["arxiv"])).toEqual({
      ok: false,
      retryInSeconds: 45,
      scope: "engines",
    });
  });

  it("the general engines have a default per minute of their own, and the configuration overrides it", () => {
    expect(new SearchGovernor().limitFor("tavily")).toBe(30);
    expect(new SearchGovernor().limitFor("brave")).toBe(30);
    expect(new SearchGovernor({ limits: { perEngine: { brave: 2 } } }).limitFor("brave")).toBe(2);
  });

  it("serves queued searches one after another, in the order they came", async () => {
    const clock = new Clock();
    const governor = new SearchGovernor({
      limits: { perMinute: 1, maxWaitMs: 200_000 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    const order: number[] = [];
    const all = [1, 2, 3].map((n) => governor.acquire(["wikipedia"]).then(() => order.push(n)));
    await Promise.all(all);
    expect(order).toEqual([1, 2, 3]);
    expect(clock.slept).toEqual([60_000, 60_000]);
  });

  it("the search tool answers rate_limited with retryInSeconds, and the engine is not asked", async () => {
    const clock = new Clock();
    const wiki = fake("wikipedia", () => hits("wikipedia"));
    const search = createSearch({
      direct: [wiki],
      engines: ["wikipedia"],
      governor: new SearchGovernor({
        limits: { perMinute: 1, maxWaitMs: 0 },
        now: () => clock.now,
        sleep: clock.sleep,
      }),
      now: () => clock.now,
    });
    ok(await search({ query: "one" }));
    const refused = await search({ query: "two" });
    expect(refused).toMatchObject({ ok: false, reason: "rate_limited", retryInSeconds: 60 });
    expect(wiki.calls).toBe(1);
  });
});

describe("the cache", () => {
  const build = (clock: Clock, reply: () => DirectSearchResult, ttlMs = 3_600_000) => {
    const wiki = fake("wikipedia", reply);
    const search = createSearch({
      direct: [wiki],
      engines: ["wikipedia"],
      cache: memorySearchCache(),
      cacheTtlMs: ttlMs,
      now: () => clock.now,
    });
    return { wiki, search };
  };

  it("an identical search (blanks and case aside) is answered from the cache and says when it was made", async () => {
    const clock = new Clock();
    const { wiki, search } = build(clock, () => hits("wikipedia", 2));
    const first = ok(await search({ query: "Climate  Change" }));
    expect(first.cached).toBeUndefined();
    clock.advance(125_000);
    const again = ok(await search({ query: " climate change ", limit: 1 }));
    expect(wiki.calls).toBe(1);
    expect(again.cached).toEqual({
      at: new Date(clock.now - 125_000).toISOString(),
      ageSeconds: 125,
    });
    expect(again.hits.map((h) => h.url)).toEqual(["https://wikipedia.example/1"]);
    expect(first.hits).toHaveLength(2);
  });

  it("a different language, range or query is a miss", async () => {
    const clock = new Clock();
    const { wiki, search } = build(clock, () => hits("wikipedia"));
    await search({ query: "x y" });
    await search({ query: "x y", language: "pt" });
    await search({ query: "x y", timeRange: "day" });
    await search({ query: "x z" });
    expect(wiki.calls).toBe(4);
  });

  it("expires after the time to live", async () => {
    const clock = new Clock();
    const { wiki, search } = build(clock, () => hits("wikipedia"), 10_000);
    await search({ query: "x y" });
    clock.advance(9_000);
    expect(ok(await search({ query: "x y" })).cached).toBeDefined();
    clock.advance(2_000);
    expect(ok(await search({ query: "x y" })).cached).toBeUndefined();
    expect(wiki.calls).toBe(2);
  });

  it("does not keep a search that found nothing", async () => {
    const clock = new Clock();
    const { wiki, search } = build(clock, () => hits("wikipedia", 0));
    await search({ query: "x y" });
    await search({ query: "x y" });
    expect(wiki.calls).toBe(2);
  });

  it("survives a restart when the store does: a second search object over the same store hits", async () => {
    const clock = new Clock();
    const store = memorySearchCache();
    const make = () =>
      createSearch({
        direct: [fake("wikipedia", () => hits("wikipedia"))],
        engines: ["wikipedia"],
        cache: store,
        now: () => clock.now,
      });
    ok(await make()({ query: "x y" }));
    const afterRestart = make();
    expect(ok(await afterRestart({ query: "x y" })).cached).toBeDefined();
  });

  it("a cache that fails does not fail the search", async () => {
    const clock = new Clock();
    const search = createSearch({
      direct: [fake("wikipedia", () => hits("wikipedia"))],
      engines: ["wikipedia"],
      cache: {
        get: async () => {
          throw new Error("db down");
        },
        set: async () => {
          throw new Error("db down");
        },
      },
      now: () => clock.now,
    });
    expect(ok(await search({ query: "x y" })).hits).toHaveLength(1);
  });
});

describe("engines that asked to be left alone", () => {
  const setup = (reply: (n: number) => DirectSearchResult) => {
    const clock = new Clock();
    const wiki = fake("wikipedia", () => hits("wikipedia"));
    const arxiv = fake("arxiv", reply);
    const governor = new SearchGovernor({ now: () => clock.now, sleep: clock.sleep });
    const search = createSearch({
      direct: [wiki, arxiv],
      engines: ["wikipedia", "arxiv"],
      governor,
      now: () => clock.now,
    });
    return { clock, wiki, arxiv, search, governor };
  };

  it("reports which engine, why and for how long, and keeps what the others gave", async () => {
    const { search } = setup(() => ({ ok: false, reason: "access denied", suspendSeconds: 3600 }));
    const out = ok(await search({ query: "x y" }));
    expect(out.suspended).toEqual([
      { engine: "arxiv", reason: "access denied", retryInSeconds: 3600 },
    ]);
    expect(out.hits).toHaveLength(1);
  });

  it("does not ask a suspended engine again, counts the time down, and asks it again when the window ends", async () => {
    const { clock, arxiv, search } = setup((n) =>
      n === 1 ? { ok: false, reason: "too many requests", suspendSeconds: 180 } : hits("arxiv"),
    );
    await search({ query: "first one" });
    clock.advance(60_000);
    const second = ok(await search({ query: "second one" }));
    expect(arxiv.calls).toBe(1);
    expect(second.suspended).toEqual([
      { engine: "arxiv", reason: "too many requests", retryInSeconds: 120 },
    ]);
    clock.advance(121_000);
    const third = ok(await search({ query: "third one" }));
    expect(arxiv.calls).toBe(2);
    expect(third.suspended).toEqual([]);
  });

  it("an engine that has no known window is reported without a time, and is asked again at once", async () => {
    const { arxiv, search } = setup((n) =>
      n === 1 ? { ok: false, reason: "timeout" } : hits("arxiv"),
    );
    const first = ok(await search({ query: "first one" }));
    expect(first.suspended).toEqual([{ engine: "arxiv", reason: "timeout" }]);
    ok(await search({ query: "second one" }));
    expect(arxiv.calls).toBe(2);
  });

  it("an engine that answers again is forgotten as suspended", async () => {
    const { clock, search, governor } = setup((n) =>
      n === 1 ? { ok: false, reason: "busy", suspendSeconds: 180 } : hits("arxiv"),
    );
    await search({ query: "first one" });
    clock.advance(181_000);
    ok(await search({ query: "second one" }));
    expect(governor.suspended().size).toBe(0);
  });

  it("with every engine suspended nothing is asked, and the answer is empty", async () => {
    const clock = new Clock();
    const arxiv = fake("arxiv", () => ({ ok: false, reason: "busy", suspendSeconds: 600 }));
    const search = createSearch({
      direct: [arxiv],
      engines: ["arxiv"],
      governor: new SearchGovernor({ now: () => clock.now, sleep: clock.sleep }),
      now: () => clock.now,
    });
    await search({ query: "first one" });
    const second = ok(await search({ query: "second one" }));
    expect(arxiv.calls).toBe(1);
    expect(second.hits).toEqual([]);
    expect(second.engines).toEqual([]);
  });
});

describe("createWebAccess", () => {
  it("one governor and one cache for all searches: the second identical search is a cache hit, the limit is shared", async () => {
    const clock = new Clock();
    const wiki = fake("wikipedia", () => hits("wikipedia"));
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      services: async () => ({ direct: [wiki], engines: ["wikipedia"] }),
      limits: { perMinute: 1, maxWaitMs: 0 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    ok(await web.search({ query: "same words" }));
    expect(ok(await web.search({ query: "SAME  words" })).cached).toBeDefined();
    expect(await web.search({ query: "other words" })).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
    expect(wiki.calls).toBe(1);
  });

  it("the cache can be turned off", async () => {
    const wiki = fake("wikipedia", () => hits("wikipedia"));
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      cacheEnabled: false,
      services: async () => ({ direct: [wiki], engines: ["wikipedia"] }),
    });
    await web.search({ query: "same words" });
    await web.search({ query: "same words" });
    expect(wiki.calls).toBe(2);
  });
});

describe("what is missing, said with the reason", () => {
  const services = async () => ({
    direct: [],
    engines: ["wikipedia"],
    readerProblem: "Docker is not available on this computer",
  });

  it("no engine could be started: the search says so, with the reason", async () => {
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: true,
      services: async () => ({ direct: [], engines: [], searchProblem: "the proxy did not start" }),
    });
    expect(await web.search({ query: "kernel" })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "The search engines could not be started (the proxy did not start).",
    });
  });

  it("an engine that is on but was not built is reported as not available", async () => {
    const search = createSearch({
      direct: [fake("wikipedia", () => hits("wikipedia"))],
      engines: ["wikipedia", "arxiv"],
    });
    const out = ok(await search({ query: "kernel" }));
    expect(out.suspended).toContainEqual({
      engine: "arxiv",
      reason: "the engine is not available",
    });
  });

  it("a render asked without the reader container says it needs that container, and why", async () => {
    const web = createWebAccess({ searchEnabled: true, readerEnabled: true, services });
    const out = await web.read({ url: "https://example.com/", render: true });
    expect(out).toEqual({
      ok: false,
      reason: "unavailable",
      message:
        "Rendering pages with JavaScript needs the reader container, which is not running here (Docker is not available on this computer). Read without render, or tell the user.",
    });
  });
});
