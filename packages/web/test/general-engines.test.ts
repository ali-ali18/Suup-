// The two general engines of the queue, Tavily and Brave (docs/BUSCA.md, "A fila da busca geral"):
// against a stub HTTP server that answers what each API's documentation says it answers (recorded
// by hand from the pages read on 24/11/2026: docs/pesquisas/fase-4-busca-alternativas-ao-ddg.md),
// with the honest user agent and the key checked exactly. Made-up keys only; no test reaches the internet.
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectSearchResult } from "../src/direct-engines.js";
import { createDirectGet } from "../src/direct-http.js";
import {
  braveEngine,
  braveQuery,
  localeParts,
  type SearchKeys,
  tavilyEngine,
} from "../src/general-engines.js";
import { userAgent } from "../src/user-agent.js";
import { type Handler, localSite } from "./helpers.js";

const HONEST = userAgent();
const TAVILY_KEY = "tvly-fake-key-for-tests-0001";
const BRAVE_KEY = "BSA-fake-key-for-tests-0002";

const sites: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const site of sites.splice(0)) await site.close();
});

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A stub API server and a request that reaches it whatever host the engine names (no TLS, no proxy). */
async function stub(
  answer: (seen: Seen) => { status?: number; headers?: Record<string, string>; body?: unknown },
) {
  const seen: Seen[] = [];
  const handler: Handler = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const reply = answer(entry);
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  };
  const site = await localSite(handler);
  sites.push(site);
  const get = createDirectGet({
    userAgent: HONEST,
    secure: false,
    dial: async () => connect({ host: "127.0.0.1", port: site.port }),
  });
  return { seen, get };
}

const keys = (table: Record<string, string | undefined>): SearchKeys => ({
  get: async (id) => table[id],
});

const TAVILY_ANSWER = {
  query: "reforma tributária",
  follow_up_questions: null,
  answer: null,
  images: [],
  results: [
    {
      url: "https://www.example.com.br/reforma",
      title: "Reforma tributária: o que muda",
      content: "A reforma tributária cria o IVA dual...",
      score: 0.81,
      raw_content: null,
    },
    { url: "javascript:alert(1)", title: "bad", content: "x", score: 0.1, raw_content: null },
    { url: "https://example.org/b", content: "só o conteúdo", score: 0.5, raw_content: null },
  ],
  response_time: "1.20",
  request_id: "123e4567-e89b-12d3-a456-426614174111",
};

const asFailure = (result: DirectSearchResult) => {
  if (result.ok) throw new Error("expected a failure");
  return result;
};

describe("localeParts", () => {
  it("splits at - or _, language lower case, region upper case, without a pattern", () => {
    expect(localeParts("pt-BR")).toEqual({ language: "pt", region: "BR" });
    expect(localeParts("pt_br")).toEqual({ language: "pt", region: "BR" });
    expect(localeParts("en")).toEqual({ language: "en" });
    expect(localeParts("zh-Hans-CN")).toEqual({ language: "zh", region: "CN" });
    expect(localeParts(undefined)).toEqual({});
    expect(localeParts("")).toEqual({});
  });
});

describe("Tavily", () => {
  it("POSTs /search with the key in the Authorization header (never in the address), the honest user agent and one credit per search", async () => {
    const { seen, get } = await stub(() => ({ body: TAVILY_ANSWER }));
    const engine = tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) });
    const out = await engine.search({ query: "reforma tributária", limit: 5, locale: "pt-BR" });
    expect(out.ok).toBe(true);
    const request = seen[0] as Seen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/search");
    expect(request.headers.host).toBe("api.tavily.com");
    expect(request.headers.authorization).toBe(`Bearer ${TAVILY_KEY}`);
    expect(request.headers["user-agent"]).toBe(HONEST);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.url).not.toContain(TAVILY_KEY);
    expect(JSON.parse(request.body)).toEqual({
      query: "reforma tributária",
      search_depth: "basic",
      topic: "general",
      max_results: 5,
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      country: "brazil",
      language: "pt",
    });
  });

  it("sends the language the caller asked for over the locale's, the time range, and no country for an unmapped region", async () => {
    const { seen, get } = await stub(() => ({ body: TAVILY_ANSWER }));
    const engine = tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) });
    await engine.search({
      query: "x y",
      limit: 3,
      language: "en",
      locale: "pt-BR",
      timeRange: "month",
    });
    await engine.search({ query: "x y", limit: 3, locale: "ja-JP" });
    await engine.search({ query: "x y", limit: 3 });
    const bodies = seen.map((s) => JSON.parse(s.body) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ country: "brazil", language: "en", time_range: "month" });
    expect(bodies[1]?.country).toBeUndefined();
    expect(bodies[1]?.language).toBe("ja");
    expect(bodies[2]?.country).toBeUndefined();
    expect(bodies[2]?.language).toBeUndefined();
    expect(bodies[2]?.time_range).toBeUndefined();
  });

  it("reads the results: title, URL, content as the snippet, only http(s) links", async () => {
    const { get } = await stub(() => ({ body: TAVILY_ANSWER }));
    const out = await tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) }).search({
      query: "x y",
      limit: 5,
    });
    expect(out).toEqual({
      ok: true,
      hits: [
        {
          title: "Reforma tributária: o que muda",
          url: "https://www.example.com.br/reforma",
          snippet: "A reforma tributária cria o IVA dual...",
          engine: "tavily",
        },
        {
          title: "https://example.org/b",
          url: "https://example.org/b",
          snippet: "só o conteúdo",
          engine: "tavily",
        },
      ],
    });
  });

  it("without a key it does not even connect", async () => {
    const { seen, get } = await stub(() => ({ body: TAVILY_ANSWER }));
    const engine = tavilyEngine({ get, keys: keys({}) });
    expect(await engine.configured?.()).toBe(false);
    expect(asFailure(await engine.search({ query: "x y", limit: 3 }))).toMatchObject({
      kind: "no_key",
    });
    expect(seen).toHaveLength(0);
  });

  it.each([
    [401, {}, "key_rejected", 3600],
    [432, {}, "quota", 3600],
    [433, {}, "quota", 3600],
    [429, { "retry-after": "30" }, "rate_limited", 30],
    [429, {}, "rate_limited", 60],
    [429, { "retry-after": "999999" }, "rate_limited", 3600],
    [500, {}, "unavailable", 60],
    [503, {}, "unavailable", 60],
  ] as const)(
    "HTTP %i is %s, and the engine is left alone for %i s",
    async (status, headers, kind, seconds) => {
      const { get } = await stub(() => ({
        status,
        headers,
        body: { detail: { error: "the service says no" } },
      }));
      const out = asFailure(
        await tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) }).search({
          query: "x y",
          limit: 3,
        }),
      );
      expect(out).toMatchObject({ kind, suspendSeconds: seconds });
    },
  );

  it("a request it did wrong (400, 422) or an answer in another shape fails without suspending the engine", async () => {
    for (const reply of [
      { status: 400, body: { detail: { error: "bad" } } },
      { status: 422, body: { detail: [] } },
      { status: 200, body: { nothing: true } },
    ]) {
      const { get } = await stub(() => reply);
      const out = asFailure(
        await tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) }).search({
          query: "x y",
          limit: 3,
        }),
      );
      expect(out.kind).toBe("other");
      expect(out.suspendSeconds).toBeUndefined();
    }
  });

  it("a connection that fails is unavailable, and never repeats the key in the message", async () => {
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      dial: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const out = asFailure(
      await tavilyEngine({ get, keys: keys({ tavily: TAVILY_KEY }) }).search({
        query: "x y",
        limit: 3,
      }),
    );
    expect(out).toMatchObject({ kind: "unavailable", suspendSeconds: 60 });
    expect(JSON.stringify(out)).not.toContain(TAVILY_KEY);
  });
});

const BRAVE_ANSWER = {
  type: "search",
  query: { original: "reforma tributária", more_results_available: true },
  web: {
    type: "search",
    results: [
      {
        title: "A <strong>reforma</strong> tributária &amp; você",
        url: "https://www.example.com.br/reforma",
        description: "O que <strong>muda</strong> com a reforma.",
        language: "pt",
      },
      { title: "sem descrição", url: "https://example.org/b", description: null },
      { title: "bad", url: "ftp://example.org/c", description: "x" },
    ],
  },
};

describe("Brave Search", () => {
  it("GETs /res/v1/web/search with the key in X-Subscription-Token (never in the address), Brazil and Portuguese, and the honest user agent", async () => {
    const { seen, get } = await stub(() => ({ body: BRAVE_ANSWER }));
    const engine = braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) });
    const out = await engine.search({ query: "reforma tributária", limit: 5, locale: "pt-BR" });
    expect(out.ok).toBe(true);
    const request = seen[0] as Seen;
    expect(request.method).toBe("GET");
    expect(request.headers.host).toBe("api.search.brave.com");
    expect(request.headers["x-subscription-token"]).toBe(BRAVE_KEY);
    expect(request.headers["user-agent"]).toBe(HONEST);
    expect(request.headers.accept).toBe("application/json");
    expect(request.url).not.toContain(BRAVE_KEY);
    const url = new URL(request.url, "https://api.search.brave.com");
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "reforma tributária",
      count: "5",
      text_decorations: "false",
      safesearch: "moderate",
      country: "BR",
      search_lang: "pt-br",
    });
  });

  it("uses the documented values: pt-pt for Portugal, the language asked for, nothing for a language it does not list", async () => {
    const { seen, get } = await stub(() => ({ body: BRAVE_ANSWER }));
    const engine = braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) });
    await engine.search({ query: "a b", limit: 3, locale: "pt-PT" });
    await engine.search({ query: "a b", limit: 3, language: "en", locale: "pt-BR" });
    await engine.search({ query: "a b", limit: 3, language: "xx" });
    await engine.search({ query: "a b", limit: 3, timeRange: "day" });
    await engine.search({ query: "a b", limit: 3, timeRange: "year" });
    const params = seen.map((s) => new URL(s.url, "https://api.search.brave.com").searchParams);
    expect(params[0]?.get("search_lang")).toBe("pt-pt");
    expect(params[0]?.get("country")).toBe("PT");
    expect(params[1]?.get("search_lang")).toBe("en");
    expect(params[1]?.get("country")).toBe("BR");
    expect(params[2]?.has("search_lang")).toBe(false);
    expect(params[2]?.has("country")).toBe(false);
    expect(params[3]?.get("freshness")).toBe("pd");
    expect(params[4]?.get("freshness")).toBe("py");
  });

  it("reads the results: markup in the text is reduced to text, only http(s) links", async () => {
    const { get } = await stub(() => ({ body: BRAVE_ANSWER }));
    const out = await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
      query: "x y",
      limit: 5,
    });
    expect(out).toEqual({
      ok: true,
      hits: [
        {
          title: "A reforma tributária & você",
          url: "https://www.example.com.br/reforma",
          snippet: "O que muda com a reforma.",
          engine: "brave",
        },
        {
          title: "sem descrição",
          url: "https://example.org/b",
          snippet: "",
          engine: "brave",
        },
      ],
    });
  });

  it("an answer without `web` is no results, not an error", async () => {
    const { get } = await stub(() => ({ body: { type: "search", query: { original: "x" } } }));
    expect(
      await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
        query: "x y",
        limit: 5,
      }),
    ).toEqual({ ok: true, hits: [] });
  });

  it("without a key it does not even connect", async () => {
    const { seen, get } = await stub(() => ({ body: BRAVE_ANSWER }));
    const engine = braveEngine({ get, keys: keys({}) });
    expect(await engine.configured?.()).toBe(false);
    expect(asFailure(await engine.search({ query: "x y", limit: 3 }))).toMatchObject({
      kind: "no_key",
    });
    expect(seen).toHaveLength(0);
  });

  const errorBody = (code: string, status: number) => ({
    type: "ErrorResponse",
    error: { id: "abc", status, code, detail: "the service says no", meta: null },
    time: 1_700_000_000,
  });

  it.each([
    ["QUOTA_LIMITED", 429, "quota", 3600],
    ["CREDIT_EXHAUSTED", 429, "quota", 3600],
    ["USAGE_LIMIT_EXCEEDED", 429, "quota", 3600],
    ["RATE_LIMITED", 429, "rate_limited", 1],
    ["SUBSCRIPTION_TOKEN_INVALID", 422, "key_rejected", 3600],
    ["SUBSCRIPTION_NOT_FOUND", 422, "key_rejected", 3600],
    ["OPTION_NOT_IN_PLAN", 422, "key_rejected", 3600],
    ["RESOURCE_NOT_ALLOWED", 422, "key_rejected", 3600],
    ["INTERNAL", 500, "unavailable", 60],
  ] as const)("the error code %s (HTTP %i) is %s", async (code, status, kind, seconds) => {
    const { get } = await stub(() => ({
      status,
      headers: { "x-ratelimit-reset": "1, 1419704" },
      body: errorBody(code, status),
    }));
    const out = asFailure(
      await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
        query: "x y",
        limit: 3,
      }),
    );
    expect(out).toMatchObject({ kind, suspendSeconds: seconds });
  });

  it("the code decides, not the status: a 429 with QUOTA_LIMITED is a quota, a 429 with RATE_LIMITED only a pause", async () => {
    const quota = await stub(() => ({ status: 429, body: errorBody("QUOTA_LIMITED", 429) }));
    const rate = await stub(() => ({ status: 429, body: errorBody("RATE_LIMITED", 429) }));
    const ask = async (get: typeof quota.get) =>
      asFailure(
        await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
          query: "x y",
          limit: 3,
        }),
      );
    expect((await ask(quota.get)).kind).toBe("quota");
    expect((await ask(rate.get)).kind).toBe("rate_limited");
  });

  it("a bare 401 or 403 is a key that was not accepted; a bare 429 reads the monthly counter of the headers", async () => {
    for (const status of [401, 403]) {
      const { get } = await stub(() => ({ status, body: {} }));
      expect(
        asFailure(
          await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
            query: "x y",
            limit: 3,
          }),
        ).kind,
      ).toBe("key_rejected");
    }
    const empty = await stub(() => ({
      status: 429,
      headers: { "x-ratelimit-remaining": "0, 0" },
      body: {},
    }));
    const busy = await stub(() => ({
      status: 429,
      headers: { "x-ratelimit-remaining": "0, 1500", "x-ratelimit-reset": "1, 999" },
      body: {},
    }));
    const run = async (get: typeof empty.get) =>
      asFailure(
        await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
          query: "x y",
          limit: 3,
        }),
      );
    expect(await run(empty.get)).toMatchObject({ kind: "quota", suspendSeconds: 3600 });
    expect(await run(busy.get)).toMatchObject({ kind: "rate_limited", suspendSeconds: 1 });
  });

  it("an answer that spends the last request of the month is kept, and the engine is left alone from then on", async () => {
    const { get } = await stub(() => ({
      headers: { "x-ratelimit-limit": "1, 2000", "x-ratelimit-remaining": "1, 0" },
      body: BRAVE_ANSWER,
    }));
    const out = await braveEngine({ get, keys: keys({ brave: BRAVE_KEY }) }).search({
      query: "x y",
      limit: 5,
    });
    expect(out).toMatchObject({
      ok: true,
      suspend: { seconds: 3600, kind: "quota" },
    });
    expect(out.ok && out.hits).toHaveLength(2);
    // Plenty left, or an unlimited plan: nothing to say.
    const plenty = await stub(() => ({
      headers: { "x-ratelimit-limit": "1, 2000", "x-ratelimit-remaining": "1, 1999" },
      body: BRAVE_ANSWER,
    }));
    const fine = await braveEngine({ get: plenty.get, keys: keys({ brave: BRAVE_KEY }) }).search({
      query: "x y",
      limit: 5,
    });
    expect(fine.ok && fine.suspend).toBeUndefined();
  });

  it("cuts a long query at 50 words or 400 characters, at a blank", () => {
    expect(braveQuery("  a   b\tc ")).toBe("a b c");
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    expect(braveQuery(words).split(" ")).toHaveLength(50);
    const long = Array.from({ length: 70 }, () => "abcdefghij").join(" ");
    const cut = braveQuery(long);
    expect(cut.length).toBeLessThanOrEqual(400);
    expect(cut.split(" ").every((w) => w === "abcdefghij")).toBe(true);
    expect(braveQuery("   ")).toBe("");
  });
});
