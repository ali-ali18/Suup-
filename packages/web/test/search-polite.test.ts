// The politeness of the search (docs/BUSCA.md, "Busca educada"): rate limits with a queue, a cache,
// and what is said about engines that were suspended. A fake clock: no test waits for real time.
import type { WebSearchOutcome } from "@suup/core";
import { describe, expect, it } from "vitest";
import { createSearch, type SearxBackend } from "../src/search.js";
import { memorySearchCache, normalizeQuery, searchCacheKey } from "../src/search-cache.js";
import { parseReason, SearchGovernor } from "../src/search-governor.js";
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

const answer = (
  hits: { url: string; title?: string; engine?: string }[],
  unresponsive: [string, string][] = [],
): string =>
  JSON.stringify({
    results: hits.map((h) => ({
      url: h.url,
      title: h.title ?? h.url,
      content: "c",
      engine: h.engine ?? "wikipedia",
    })),
    unresponsive_engines: unresponsive,
  });

function backendOf(
  replies: (params: URLSearchParams) => string,
): SearxBackend & { asked: URLSearchParams[] } {
  const asked: URLSearchParams[] = [];
  return {
    asked,
    async query(params) {
      asked.push(params);
      return replies(params);
    },
  };
}

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

describe("the reasons SearXNG gives", () => {
  it("knows the windows by exact text, and only those", () => {
    expect(parseReason("CAPTCHA")).toEqual({
      suspendedBefore: false,
      kind: "CAPTCHA",
      windowSeconds: 3600,
    });
    expect(parseReason("Suspended: too many requests")).toEqual({
      suspendedBefore: true,
      kind: "too many requests",
      windowSeconds: 180,
    });
    expect(parseReason("Suspended: access denied").windowSeconds).toBe(180);
    expect(parseReason("timeout")).toEqual({ suspendedBefore: false, kind: "timeout" });
    expect(parseReason("captcha").windowSeconds).toBeUndefined();
    expect(parseReason("Suspended: something else").windowSeconds).toBeUndefined();
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
      limits: { perMinute: 100, perEngine: { duckduckgo: 1 }, maxWaitMs: 1_000 },
      now: () => clock.now,
      sleep: clock.sleep,
    });
    expect(await governor.acquire(["wikipedia", "duckduckgo"])).toMatchObject({
      ok: true,
      engines: ["wikipedia", "duckduckgo"],
    });
    clock.advance(15_000);
    expect(await governor.acquire(["wikipedia", "duckduckgo"])).toEqual({
      ok: true,
      engines: ["wikipedia"],
      throttled: [{ engine: "duckduckgo", retryInSeconds: 45 }],
      waitedMs: 0,
    });
    // Only the engine that is over its limit: nothing to ask, so the time to come back.
    expect(await governor.acquire(["duckduckgo"])).toEqual({
      ok: false,
      retryInSeconds: 45,
      scope: "engines",
    });
  });

  it("DuckDuckGo's own default is low (6 a minute), and the configuration overrides it", () => {
    expect(new SearchGovernor().limitFor("duckduckgo")).toBeLessThanOrEqual(6);
    expect(
      new SearchGovernor({ limits: { perEngine: { duckduckgo: 2 } } }).limitFor("duckduckgo"),
    ).toBe(2);
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

  it("the search tool answers rate_limited with retryInSeconds, and the backend is not asked", async () => {
    const clock = new Clock();
    const backend = backendOf(() => answer([{ url: "https://a.example/" }]));
    const search = createSearch({
      backend,
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
    expect(backend.asked).toHaveLength(1);
  });
});

describe("the cache", () => {
  const build = (clock: Clock, replies: (p: URLSearchParams) => string, ttlMs = 3_600_000) => {
    const backend = backendOf(replies);
    const cache = memorySearchCache();
    const search = createSearch({
      backend,
      engines: ["wikipedia", "duckduckgo"],
      cache,
      cacheTtlMs: ttlMs,
      now: () => clock.now,
    });
    return { backend, cache, search };
  };

  it("an identical search (blanks and case aside) is answered from the cache and says when it was made", async () => {
    const clock = new Clock();
    const { backend, search } = build(clock, () =>
      answer([{ url: "https://a.example/1" }, { url: "https://a.example/2" }]),
    );
    const first = ok(await search({ query: "Climate  Change" }));
    expect(first.cached).toBeUndefined();
    clock.advance(125_000);
    const again = ok(await search({ query: " climate change ", limit: 1 }));
    expect(backend.asked).toHaveLength(1);
    expect(again.cached).toEqual({
      at: new Date(clock.now - 125_000).toISOString(),
      ageSeconds: 125,
    });
    expect(again.hits.map((h) => h.url)).toEqual(["https://a.example/1"]);
    expect(first.hits).toHaveLength(2);
  });

  it("a different language, range or query is a miss", async () => {
    const clock = new Clock();
    const { backend, search } = build(clock, () => answer([{ url: "https://a.example/1" }]));
    await search({ query: "x y" });
    await search({ query: "x y", language: "pt" });
    await search({ query: "x y", timeRange: "day" });
    await search({ query: "x z" });
    expect(backend.asked).toHaveLength(4);
  });

  it("expires after the time to live", async () => {
    const clock = new Clock();
    const { backend, search } = build(
      clock,
      () => answer([{ url: "https://a.example/1" }]),
      10_000,
    );
    await search({ query: "x y" });
    clock.advance(9_000);
    expect(ok(await search({ query: "x y" })).cached).toBeDefined();
    clock.advance(2_000);
    expect(ok(await search({ query: "x y" })).cached).toBeUndefined();
    expect(backend.asked).toHaveLength(2);
  });

  it("does not keep a search that found nothing", async () => {
    const clock = new Clock();
    const { backend, search } = build(clock, () => answer([]));
    await search({ query: "x y" });
    await search({ query: "x y" });
    expect(backend.asked).toHaveLength(2);
  });

  it("survives a restart when the store does: a second search object over the same store hits", async () => {
    const clock = new Clock();
    const store = memorySearchCache();
    const make = () =>
      createSearch({
        backend: backendOf(() => answer([{ url: "https://a.example/1" }])),
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
      backend: backendOf(() => answer([{ url: "https://a.example/1" }])),
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

describe("engines suspended by the search service", () => {
  const engines = ["wikipedia", "duckduckgo"];
  const setup = (reply: (n: number) => string) => {
    const clock = new Clock();
    let n = 0;
    const backend = backendOf(() => reply(++n));
    const governor = new SearchGovernor({ now: () => clock.now, sleep: clock.sleep });
    const search = createSearch({ backend, engines, governor, now: () => clock.now });
    return { clock, backend, search, governor };
  };

  it("reports which engine, why and for how long after a captcha, and the general search is unavailable", async () => {
    const { search } = setup(() =>
      answer([{ url: "https://w.example/1" }], [["duckduckgo", "CAPTCHA"]]),
    );
    const out = ok(await search({ query: "x y" }));
    expect(out.suspended).toEqual([
      { engine: "duckduckgo", reason: "CAPTCHA", retryInSeconds: 3600 },
    ]);
    expect(out.generalUnavailable).toEqual({ retryInSeconds: 3600 });
    expect(out.hits).toHaveLength(1);
  });

  it("a too-many-requests lasts three minutes", async () => {
    const { search } = setup(() => answer([], [["duckduckgo", "too many requests"]]));
    expect(ok(await search({ query: "x y" })).suspended[0]).toMatchObject({ retryInSeconds: 180 });
  });

  it("does not ask a suspended engine again, counts the time down, and asks it again when the window ends", async () => {
    const { clock, backend, search } = setup((n) =>
      n === 1
        ? answer([{ url: "https://w.example/1" }], [["duckduckgo", "CAPTCHA"]])
        : answer([
            { url: "https://w.example/2" },
            { url: "https://d.example/2", engine: "duckduckgo" },
          ]),
    );
    await search({ query: "first one" });
    clock.advance(600_000);
    const second = ok(await search({ query: "second one" }));
    expect(backend.asked[1]?.get("engines")).toBe("wikipedia");
    expect(second.suspended).toEqual([
      { engine: "duckduckgo", reason: "Suspended: CAPTCHA", retryInSeconds: 3000 },
    ]);
    expect(second.generalUnavailable).toEqual({ retryInSeconds: 3000 });
    clock.advance(3_001_000);
    const third = ok(await search({ query: "third one" }));
    expect(backend.asked[2]?.get("engines")).toBe("wikipedia,duckduckgo");
    expect(third.suspended).toEqual([]);
    expect(third.generalUnavailable).toBeUndefined();
  });

  it("with no general engine available the search service is not even asked, and the answer says when it is back", async () => {
    const { backend, search } = setup(() =>
      answer(
        [],
        [
          ["wikipedia", "CAPTCHA"],
          ["duckduckgo", "CAPTCHA"],
        ],
      ),
    );
    await search({ query: "first one" });
    const second = ok(await search({ query: "second one" }));
    expect(backend.asked).toHaveLength(1);
    expect(second.hits).toEqual([]);
    expect(second.engines).toEqual([]);
    expect(second.generalUnavailable).toEqual({ retryInSeconds: 3600 });
  });

  it("an engine that has no known window is reported without a time, and is asked again at once", async () => {
    const { backend, search } = setup((n) =>
      n === 1 ? answer([], [["duckduckgo", "timeout"]]) : answer([{ url: "https://d.example/" }]),
    );
    const first = ok(await search({ query: "first one" }));
    expect(first.suspended).toEqual([{ engine: "duckduckgo", reason: "timeout" }]);
    ok(await search({ query: "second one" }));
    expect(backend.asked[1]?.get("engines")).toBe("wikipedia,duckduckgo");
  });

  it("an engine that answers again is forgotten as suspended", async () => {
    const { clock, search, governor } = setup((n) =>
      n === 1
        ? answer([], [["duckduckgo", "too many requests"]])
        : answer([{ url: "https://d.example/" }]),
    );
    await search({ query: "first one" });
    clock.advance(181_000);
    ok(await search({ query: "second one" }));
    expect(governor.suspended().size).toBe(0);
  });
});

describe("createWebAccess", () => {
  it("one governor and one cache for all searches: the second identical search is a cache hit, the limit is shared", async () => {
    const clock = new Clock();
    const backend = backendOf(() => answer([{ url: "https://a.example/1" }]));
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      services: async () => ({ searchBackend: backend, engines: ["wikipedia"] }),
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
    expect(backend.asked).toHaveLength(1);
  });

  it("the cache can be turned off", async () => {
    const backend = backendOf(() => answer([{ url: "https://a.example/1" }]));
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      cacheEnabled: false,
      services: async () => ({ searchBackend: backend, engines: ["wikipedia"] }),
    });
    await web.search({ query: "same words" });
    await web.search({ query: "same words" });
    expect(backend.asked).toHaveLength(2);
  });
});
