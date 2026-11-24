// The queue of general engines (docs/BUSCA.md, "A fila da busca geral"): Tavily first, then Brave;
// when one has no quota, is unavailable or fails, the next is used by itself; when none can answer,
// the answer says the general search has no quota and the other engines' hits are kept. Real
// Tavily and Brave modules against a stub server; a fake clock; made-up keys only.
import { connect } from "node:net";
import type { WebSearchOutcome } from "@suup/core";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectEngine } from "../src/direct-engines.js";
import { createDirectGet } from "../src/direct-http.js";
import { braveEngine, type SearchKeys, tavilyEngine } from "../src/general-engines.js";
import { createSearch } from "../src/search.js";
import { memorySearchCache } from "../src/search-cache.js";
import { SearchGovernor, type SearchLimits } from "../src/search-governor.js";
import { memorySearchUsage } from "../src/search-usage.js";
import { createWebAccess, searchProblemLogLine } from "../src/service.js";
import { userAgent } from "../src/user-agent.js";
import { localSite } from "./helpers.js";

const TAVILY_KEY = "tvly-fake-key-for-tests-0001";
const BRAVE_KEY = "BSA-fake-key-for-tests-0002";
/// What the person typed: it must never reach a log line.
const SECRET_QUERY = "minha dívida com o banco xyzzy";

const sites: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const site of sites.splice(0)) await site.close();
});

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

const tavilyOk: Reply = {
  body: {
    results: [{ url: "https://tavily.example/1", title: "T1", content: "from tavily" }],
  },
};
const braveOk: Reply = {
  body: {
    web: { results: [{ title: "B1", url: "https://brave.example/1", description: "from brave" }] },
  },
};
const tavilyQuota: Reply = {
  status: 432,
  body: { detail: { error: "This request exceeds your plan's set usage limit." } },
};
const braveQuota: Reply = {
  status: 429,
  body: { type: "ErrorResponse", error: { id: "x", status: 429, code: "QUOTA_LIMITED" } },
};

class Clock {
  now = Date.UTC(2026, 10, 24, 12, 0, 0);
  advance(ms: number): void {
    this.now += ms;
  }
}

/** The real engines on a stub server that answers by host: `replies.tavily(n)` is the answer to the n-th request. */
async function setup(options: {
  tavily?: (n: number) => Reply;
  brave?: (n: number) => Reply;
  keys?: Record<string, string | undefined>;
  engines?: string[];
  order?: string[];
  others?: DirectEngine[];
  limits?: Partial<SearchLimits>;
}) {
  const calls = { tavily: 0, brave: 0 };
  const site = await localSite((req, res) => {
    req.resume();
    req.on("end", () => {
      const host = req.headers.host;
      const which = host === "api.tavily.com" ? "tavily" : "brave";
      calls[which] += 1;
      const reply = (options[which] ?? (() => (which === "tavily" ? tavilyOk : braveOk)))(
        calls[which],
      );
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(JSON.stringify(reply.body));
    });
  });
  sites.push(site);
  const get = createDirectGet({
    userAgent: userAgent(),
    secure: false,
    dial: async () => connect({ host: "127.0.0.1", port: site.port }),
  });
  const table = options.keys ?? { tavily: TAVILY_KEY, brave: BRAVE_KEY };
  const keys: SearchKeys = { get: async (id) => table[id] };
  const clock = new Clock();
  const logs: string[] = [];
  const usage = memorySearchUsage();
  const governor = new SearchGovernor({
    now: () => clock.now,
    sleep: async () => undefined,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const cache = memorySearchCache();
  const engines = options.engines ?? ["tavily", "brave"];
  const search = createSearch({
    direct: [tavilyEngine({ get, keys }), braveEngine({ get, keys }), ...(options.others ?? [])],
    engines,
    ...(options.order === undefined ? {} : { generalOrder: options.order }),
    locale: "pt-BR",
    governor,
    cache,
    usage,
    log: (line) => logs.push(line),
    now: () => clock.now,
  });
  return { search, calls, clock, logs, usage, governor, cache, keys };
}

const ok = (outcome: WebSearchOutcome) => {
  if (!outcome.ok) throw new Error(`expected a result: ${outcome.message}`);
  return outcome;
};

describe("the queue of general engines", () => {
  it("Tavily answers first, and Brave is not even asked", async () => {
    const { search, calls, usage, clock } = await setup({});
    const out = ok(await search({ query: "alguma coisa" }));
    expect(out.generalEngine).toBe("tavily");
    expect(out.hits.map((h) => h.engine)).toEqual(["tavily"]);
    expect(out.engines).toEqual(["tavily"]);
    expect(out.generalUnavailable).toBeUndefined();
    expect(calls).toEqual({ tavily: 1, brave: 0 });
    expect(await usage.month(new Date(clock.now))).toEqual({ tavily: 1 });
  });

  it("when Tavily has no quota the search goes on to Brave by itself, and the answer says who answered and who was passed over", async () => {
    const { search, calls, logs, usage, clock } = await setup({ tavily: () => tavilyQuota });
    const out = ok(await search({ query: SECRET_QUERY }));
    expect(out.generalEngine).toBe("brave");
    expect(out.hits.map((h) => h.engine)).toEqual(["brave"]);
    expect(out.engines).toEqual(["tavily", "brave"]);
    expect(out.suspended).toEqual([
      { engine: "tavily", reason: expect.stringContaining("no credits"), retryInSeconds: 3600 },
    ]);
    expect(calls).toEqual({ tavily: 1, brave: 1 });
    // The failover is in the log, with the engines and the kind of failure, never the query.
    expect(logs).toEqual(["web_search: failover tavily (quota) -> brave"]);
    expect(logs.join("\n")).not.toContain("dívida");
    // Only the search that was answered is counted, and only for who answered.
    expect(await usage.month(new Date(clock.now))).toEqual({ brave: 1 });
  });

  it("an engine out of quota is not asked again until its window ends; then it is tried again", async () => {
    const { search, calls, clock } = await setup({
      tavily: (n) => (n === 1 ? tavilyQuota : tavilyOk),
    });
    await search({ query: "um dois" });
    clock.advance(60_000);
    const second = ok(await search({ query: "três quatro" }));
    expect(calls.tavily).toBe(1);
    expect(second.generalEngine).toBe("brave");
    clock.advance(3_600_000);
    const third = ok(await search({ query: "cinco seis" }));
    expect(calls.tavily).toBe(2);
    expect(third.generalEngine).toBe("tavily");
  });

  it("a rate limit (429 with Retry-After) passes to the next engine and waits only that long", async () => {
    const { search, calls, clock, logs } = await setup({
      tavily: (n) =>
        n === 1
          ? { status: 429, headers: { "retry-after": "30" }, body: { detail: { error: "slow" } } }
          : tavilyOk,
    });
    const first = ok(await search({ query: "um dois" }));
    expect(first.generalEngine).toBe("brave");
    expect(first.suspended).toMatchObject([{ engine: "tavily", retryInSeconds: 30 }]);
    expect(logs).toEqual(["web_search: failover tavily (rate_limited) -> brave"]);
    clock.advance(31_000);
    expect(ok(await search({ query: "três quatro" })).generalEngine).toBe("tavily");
    expect(calls.tavily).toBe(2);
  });

  it("an engine that is down or whose key is refused is passed over too", async () => {
    const down = await setup({ tavily: () => ({ status: 503, body: {} }) });
    expect(ok(await down.search({ query: "um dois" })).generalEngine).toBe("brave");
    expect(down.logs).toEqual(["web_search: failover tavily (unavailable) -> brave"]);
    const refused = await setup({ tavily: () => ({ status: 401, body: {} }) });
    expect(ok(await refused.search({ query: "um dois" })).generalEngine).toBe("brave");
    expect(refused.logs).toEqual(["web_search: failover tavily (key_rejected) -> brave"]);
  });

  it("when every engine of the queue is out of quota the answer says so and keeps what the other engines gave", async () => {
    const wiki: DirectEngine = {
      id: "wikipedia",
      async search() {
        return {
          ok: true,
          hits: [{ title: "W", url: "https://w.example/1", snippet: "s", engine: "wikipedia" }],
        };
      },
    };
    const { search, logs, calls } = await setup({
      tavily: () => tavilyQuota,
      brave: () => braveQuota,
      engines: ["wikipedia", "tavily", "brave"],
      others: [wiki],
    });
    const out = ok(await search({ query: SECRET_QUERY }));
    expect(out.generalUnavailable).toEqual({ cause: "quota", retryInSeconds: 3600 });
    expect(out.generalEngine).toBeUndefined();
    expect(out.hits.map((h) => h.engine)).toEqual(["wikipedia"]);
    expect(out.suspended.map((s) => s.engine).sort()).toEqual(["brave", "tavily"]);
    expect(logs).toEqual([
      "web_search: failover tavily (quota) -> brave",
      "web_search: failover brave (quota): no general engine left",
    ]);
    // The next search does not ask either of them again: no wasted call, same answer.
    const again = ok(await search({ query: "outra coisa agora" }));
    expect(calls).toEqual({ tavily: 1, brave: 1 });
    expect(again.generalUnavailable).toMatchObject({ cause: "quota" });
    expect(again.hits.map((h) => h.engine)).toEqual(["wikipedia"]);
  });

  it("an engine without a key is skipped without being asked, and Brave answers", async () => {
    const { search, calls, logs, usage, clock } = await setup({ keys: { brave: BRAVE_KEY } });
    const out = ok(await search({ query: "um dois" }));
    expect(out.generalEngine).toBe("brave");
    expect(calls).toEqual({ tavily: 0, brave: 1 });
    expect(out.suspended).toEqual([]);
    expect(logs).toEqual([]);
    expect(await usage.month(new Date(clock.now))).toEqual({ brave: 1 });
  });

  it("with no key at all the general search is reported as not set up, and nothing is asked", async () => {
    const { search, calls } = await setup({ keys: {} });
    const out = ok(await search({ query: "um dois" }));
    expect(out.generalUnavailable).toEqual({ cause: "no_key" });
    expect(out.hits).toEqual([]);
    expect(out.engines).toEqual([]);
    expect(calls).toEqual({ tavily: 0, brave: 0 });
  });

  it("the order is configurable: Brave first", async () => {
    const { search, calls } = await setup({ order: ["brave", "tavily"] });
    const out = ok(await search({ query: "um dois" }));
    expect(out.generalEngine).toBe("brave");
    expect(calls).toEqual({ tavily: 0, brave: 1 });
    const flipped = await setup({ order: ["brave", "tavily"], brave: () => braveQuota });
    const second = ok(await flipped.search({ query: "um dois" }));
    expect(second.generalEngine).toBe("tavily");
    expect(flipped.logs).toEqual(["web_search: failover brave (quota) -> tavily"]);
  });

  it("an engine that is turned off is not in the queue at all", async () => {
    const { search, calls } = await setup({ engines: ["brave"] });
    expect(ok(await search({ query: "um dois" })).generalEngine).toBe("brave");
    expect(calls.tavily).toBe(0);
  });

  it("Suup's own limit for an engine passes to the next one, and says so", async () => {
    const { search, calls } = await setup({ limits: { perEngine: { tavily: 1 } } });
    expect(ok(await search({ query: "um dois" })).generalEngine).toBe("tavily");
    const out = ok(await search({ query: "três quatro" }));
    expect(out.generalEngine).toBe("brave");
    expect(out.throttled).toMatchObject([{ engine: "tavily" }]);
    expect(calls).toEqual({ tavily: 1, brave: 1 });
  });

  it("when Suup's own limit leaves nothing to ask at all, the search is rate_limited", async () => {
    const { search, calls } = await setup({
      limits: { perEngine: { tavily: 1, brave: 1 }, maxWaitMs: 0 },
    });
    ok(await search({ query: "um dois" }));
    // Tavily is at its limit and passes to Brave, which is asked once; then both are at their limits.
    ok(await search({ query: "três quatro" }));
    const third = await search({ query: "cinco seis" });
    expect(third).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(calls).toEqual({ tavily: 1, brave: 1 });
  });

  it("a Brave answer that spends the month's last request is kept, then Brave is left alone", async () => {
    const { search, calls, clock } = await setup({
      engines: ["brave"],
      brave: () => ({
        ...braveOk,
        headers: { "x-ratelimit-limit": "1, 1000", "x-ratelimit-remaining": "1, 0" },
      }),
    });
    const first = ok(await search({ query: "um dois" }));
    expect(first.hits).toHaveLength(1);
    expect(first.generalEngine).toBe("brave");
    clock.advance(10_000);
    const second = ok(await search({ query: "três quatro" }));
    expect(calls.brave).toBe(1);
    expect(second.generalUnavailable).toMatchObject({ cause: "quota" });
  });
});

describe("the cache and Brave's terms", () => {
  it("a Tavily answer is cached: the identical search is answered without asking", async () => {
    const { search, calls } = await setup({});
    await search({ query: "um dois" });
    const again = ok(await search({ query: "UM  dois" }));
    expect(again.cached).toBeDefined();
    expect(calls.tavily).toBe(1);
  });

  it("a Brave answer is NEVER cached (its terms): the identical search asks again", async () => {
    const { search, calls, cache, clock } = await setup({ engines: ["brave"] });
    await search({ query: "um dois" });
    const again = ok(await search({ query: "um dois" }));
    expect(again.cached).toBeUndefined();
    expect(calls.brave).toBe(2);
    expect(
      await cache.get(JSON.stringify(["um dois", ["brave"], "", ""]), clock.now),
    ).toBeUndefined();
  });

  it("an answer that mixes Brave's hits with others' is not cached either", async () => {
    const wiki: DirectEngine = {
      id: "wikipedia",
      search: async () => ({
        ok: true,
        hits: [{ title: "W", url: "https://w.example/1", snippet: "s", engine: "wikipedia" }],
      }),
    };
    const { search, calls } = await setup({
      engines: ["wikipedia", "brave"],
      others: [wiki],
    });
    await search({ query: "um dois" });
    const again = ok(await search({ query: "um dois" }));
    expect(again.cached).toBeUndefined();
    expect(calls.brave).toBe(2);
  });

  it("when Tavily has no quota and Brave answers, nothing of Brave is kept in the cache", async () => {
    const { search, calls } = await setup({ tavily: () => tavilyQuota });
    await search({ query: "um dois" });
    const again = ok(await search({ query: "um dois" }));
    expect(again.cached).toBeUndefined();
    expect(calls.brave).toBe(2);
  });
});

describe("no query in the logs", () => {
  it("the failover lines and the problem line carry engines and reasons, never the words searched", async () => {
    const { search, logs } = await setup({
      tavily: () => tavilyQuota,
      brave: () => braveQuota,
    });
    const out = await search({ query: SECRET_QUERY });
    const lines = [...logs];
    const problem = searchProblemLogLine(out);
    if (problem !== undefined) lines.push(problem);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).not.toContain("dívida");
      expect(line).not.toContain("banco");
      expect(line).not.toContain("xyzzy");
      expect(line).not.toContain(TAVILY_KEY);
      expect(line).not.toContain(BRAVE_KEY);
    }
    expect(problem).toContain("no general web engine available (quota)");
  });

  it("the web access writes the failover line through its own log", async () => {
    const lines: string[] = [];
    const site = await localSite((req, res) => {
      req.resume();
      req.on("end", () => {
        const quota = req.headers.host === "api.tavily.com";
        const reply = quota ? tavilyQuota : braveOk;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    sites.push(site);
    const get = createDirectGet({
      userAgent: userAgent(),
      secure: false,
      dial: async () => connect({ host: "127.0.0.1", port: site.port }),
    });
    const keys: SearchKeys = { get: async (id) => (id === "tavily" ? TAVILY_KEY : BRAVE_KEY) };
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      services: async () => ({
        direct: [tavilyEngine({ get, keys }), braveEngine({ get, keys })] as DirectEngine[],
        engines: ["tavily", "brave"],
      }),
      engines: ["tavily", "brave"],
      keys,
      log: (line) => lines.push(line),
    });
    const out = ok(await web.search({ query: SECRET_QUERY }));
    expect(out.generalEngine).toBe("brave");
    expect(lines[0]).toBe("web_search: failover tavily (quota) -> brave");
    expect(lines.join("\n")).not.toContain("dívida");
    expect(lines.join("\n")).not.toContain(TAVILY_KEY);
    // The status for Settings: who is out of quota, who answered how many this month. No key, no query.
    const providers = await web.searchProviders();
    expect(providers).toMatchObject([
      { id: "tavily", position: 1, state: "quota", retryInSeconds: 3600, searchesThisMonth: 0 },
      { id: "brave", position: 2, state: "ready", searchesThisMonth: 1 },
    ]);
    expect(JSON.stringify(providers)).not.toContain(TAVILY_KEY);
    expect(JSON.stringify(providers)).not.toContain("dívida");
  });
});

describe("the usage count", () => {
  it("counts per engine and per calendar month (UTC), and starts again the next month", async () => {
    const usage = memorySearchUsage();
    await usage.record("tavily", new Date(Date.UTC(2026, 10, 30, 23, 59)));
    await usage.record("tavily", new Date(Date.UTC(2026, 10, 1, 0, 0)));
    await usage.record("brave", new Date(Date.UTC(2026, 10, 15)));
    await usage.record("tavily", new Date(Date.UTC(2026, 11, 1, 0, 0)));
    expect(await usage.month(new Date(Date.UTC(2026, 10, 24)))).toEqual({ tavily: 2, brave: 1 });
    expect(await usage.month(new Date(Date.UTC(2026, 11, 2)))).toEqual({ tavily: 1 });
    expect(await usage.month(new Date(Date.UTC(2027, 0, 1)))).toEqual({});
  });

  it("a usage store that fails does not fail the search", async () => {
    const { search, usage } = await setup({});
    usage.record = async () => {
      throw new Error("db down");
    };
    expect(ok(await search({ query: "um dois" })).generalEngine).toBe("tavily");
  });
});
