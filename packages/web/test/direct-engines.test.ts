// The engines Suup asks itself (Wikipedia, arXiv, Stack Overflow; docs/BUSCA.md and
// docs/pesquisas/fase-4-busca-apis-diretas.md): against a stub HTTP server, with the honest user
// agent asserted exactly, query encoding, result mapping, limits, backoff and quota, and answers
// that are not what was expected. No test reaches the internet.
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { EgressProxy } from "@suup/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARXIV_INTERVAL_MS,
  arxivEngine,
  arxivSearchQuery,
  type DirectEngine,
  htmlText,
  Pacer,
  stackOverflowEngine,
  wikipediaEngine,
} from "../src/direct-engines.js";
import { createDirectGet, type DirectGet } from "../src/direct-http.js";
import { startWebServices } from "../src/docker-services.js";
import { DEFAULT_ENGINES, engineHosts } from "../src/engines.js";
import { createSearch } from "../src/search.js";
import { memorySearchCache } from "../src/search-cache.js";
import { SearchGovernor } from "../src/search-governor.js";
import { createWebAccess } from "../src/service.js";
import { userAgent } from "../src/user-agent.js";
import { type Handler, localSite } from "./helpers.js";

const HONEST = "SuupBot/0.1 (+https://github.com/ali-ali18/suup-)";

const sites: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const site of sites.splice(0)) await site.close();
});

/** A stub API server and a GET that reaches it whatever host the engine names (no TLS, no proxy). */
async function stub(handler: Handler) {
  const site = await localSite(handler);
  sites.push(site);
  const get = createDirectGet({
    userAgent: userAgent(),
    secure: false,
    dial: async () => connect({ host: "127.0.0.1", port: site.port }),
  });
  return { site, get };
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

const text =
  (body: string, status = 200, type = "text/plain"): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

const query = (url: string): URLSearchParams => new URL(url, "http://x").searchParams;

describe("the honest user agent", () => {
  it("is exactly SuupBot/<version> (+<repository>), as the owner decided", () => {
    expect(userAgent()).toBe(HONEST);
  });
});

describe("Wikipedia", () => {
  const answer = {
    batchcomplete: true,
    query: {
      searchinfo: { totalhits: 2 },
      search: [
        {
          ns: 0,
          title: "Alan Turing",
          pageid: 1,
          snippet:
            'English <span class="searchmatch">mathematician</span> &amp; computer scientist, &quot;father&quot; of AI',
        },
        { ns: 0, title: "AC/DC", pageid: 2, snippet: "A band" },
      ],
    },
  };

  it("asks the MediaWiki Action API with the honest name, the exact host, and the query encoded", async () => {
    const { site, get } = await stub(json(answer));
    const engine = wikipediaEngine({ get, languages: ["en"] });
    const result = await engine.search({ query: 'C++ & "quotes" ü', limit: 5 });
    expect(site.requests).toHaveLength(1);
    const request = site.requests[0];
    expect(request?.headers["user-agent"]).toBe(HONEST);
    expect(request?.headers.host).toBe("en.wikipedia.org");
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.url.startsWith("/w/api.php?")).toBe(true);
    const params = query(request?.url ?? "");
    expect(Object.fromEntries(params)).toEqual({
      action: "query",
      list: "search",
      srsearch: 'C++ & "quotes" ü',
      srlimit: "5",
      srprop: "snippet",
      srnamespace: "0",
      format: "json",
      formatversion: "2",
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("maps the results: link by title, markup and entities of the snippet turned into text", async () => {
    const { get } = await stub(json(answer));
    const result = await wikipediaEngine({ get, languages: ["en"] }).search({
      query: "turing",
      limit: 5,
    });
    expect(result).toEqual({
      ok: true,
      hits: [
        {
          title: "Alan Turing",
          url: "https://en.wikipedia.org/wiki/Alan_Turing",
          snippet: 'English mathematician & computer scientist, "father" of AI',
          engine: "wikipedia",
        },
        {
          title: "AC/DC",
          url: "https://en.wikipedia.org/wiki/AC%2FDC",
          snippet: "A band",
          engine: "wikipedia",
        },
      ],
    });
  });

  it("asks the language edition the caller named, or every configured one (one after the other) when none was", async () => {
    const hosts: string[] = [];
    const { get } = await stub((req, res) => {
      hosts.push(req.headers.host ?? "");
      json({ query: { search: [{ title: `T ${req.headers.host}`, snippet: "s" }] } })(req, res);
    });
    const engine = wikipediaEngine({ get, languages: ["en", "pt"] });
    expect((await engine.search({ query: "x", limit: 5, language: "pt-BR" })).ok).toBe(true);
    expect(hosts).toEqual(["pt.wikipedia.org"]);
    hosts.length = 0;
    const both = await engine.search({ query: "x", limit: 5 });
    expect(hosts).toEqual(["en.wikipedia.org", "pt.wikipedia.org"]);
    expect(both.ok && both.hits.map((h) => h.url)).toEqual([
      "https://en.wikipedia.org/wiki/T_en.wikipedia.org",
      "https://pt.wikipedia.org/wiki/T_pt.wikipedia.org",
    ]);
    hosts.length = 0;
    await engine.search({ query: "x", limit: 5, language: "de" });
    expect(hosts).toEqual(["en.wikipedia.org", "pt.wikipedia.org"]);
  });

  it("an API error is a refusal with the code; ratelimited suspends the engine", async () => {
    const limited = await stub(
      json({ error: { code: "ratelimited", info: "You've exceeded your rate limit." } }),
    );
    expect(
      await wikipediaEngine({ get: limited.get, languages: ["en"] }).search({
        query: "x",
        limit: 3,
      }),
    ).toEqual({
      ok: false,
      reason: "Wikipedia refused the search (ratelimited: You've exceeded your rate limit.)",
      suspendSeconds: 180,
    });
    const other = await stub(json({ error: { code: "badvalue", info: "no" } }));
    const result = await wikipediaEngine({ get: other.get, languages: ["en"] }).search({
      query: "x",
      limit: 3,
    });
    expect(result).toEqual({ ok: false, reason: "Wikipedia refused the search (badvalue: no)" });
  });

  it("HTTP 429 and 403 leave the engine alone for a while; other statuses only fail", async () => {
    for (const [status, expected] of [
      [429, { reason: "too many requests", suspendSeconds: 180 }],
      [403, { reason: "access denied", suspendSeconds: 3600 }],
      [500, { reason: "HTTP 500" }],
    ] as const) {
      const { get } = await stub(text("no", status));
      expect(
        await wikipediaEngine({ get, languages: ["en"] }).search({ query: "x", limit: 3 }),
      ).toEqual({ ok: false, ...expected });
    }
  });

  it("answers that are not the documented shape fail closed with a clear message", async () => {
    for (const body of [
      "<html>captcha</html>",
      "[]",
      '{"foo":1}',
      '{"query":{"search":[{"x":1}]}}',
    ]) {
      const { get } = await stub(text(body, 200, "application/json"));
      expect(
        await wikipediaEngine({ get, languages: ["en"] }).search({ query: "x", limit: 3 }),
      ).toEqual({ ok: false, reason: "Wikipedia answered in a format that was not expected" });
    }
  });

  it("htmlText reads markup as a document, never as a pattern", () => {
    expect(htmlText("a <b>b</b> &lt;i&gt; <script>alert(1)</script>")).toBe("a b <i> alert(1)");
  });
});

const ATOM = (entries: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>ArXiv Query: search_query=all:electron</title>
  <id>http://arxiv.org/api/abc</id>
  <opensearch:totalResults>2</opensearch:totalResults>
  ${entries}
</feed>`;

const ENTRIES = `
  <entry>
    <id>http://arxiv.org/abs/hep-ex/0307015v1</id>
    <title>Multi-Electron Production
      at High Transverse Momenta</title>
    <summary>  Multi-electron events are searched
      for in ep collisions.  </summary>
    <published>2003-07-07T13:46:39-04:00</published>
    <link href="http://arxiv.org/abs/hep-ex/0307015v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/hep-ex/0307015v1" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v2</id>
    <title>Second paper</title>
    <summary>Second summary.</summary>
  </entry>`;

describe("arXiv", () => {
  it("asks export.arxiv.org with the honest name and every word as an all: term", async () => {
    const { site, get } = await stub(text(ATOM(ENTRIES), 200, "application/atom+xml"));
    const engine = arxivEngine({ get, sleep: async () => undefined });
    await engine.search({ query: 'Electron  "thermal" (conductivity) AND', limit: 4 });
    const request = site.requests[0];
    expect(request?.headers["user-agent"]).toBe(HONEST);
    expect(request?.headers.host).toBe("export.arxiv.org");
    expect(request?.headers.accept).toBe("application/atom+xml");
    expect(request?.url.startsWith("/api/query?")).toBe(true);
    expect(Object.fromEntries(query(request?.url ?? ""))).toEqual({
      search_query: "all:Electron AND all:thermal AND all:conductivity",
      start: "0",
      max_results: "4",
      sortBy: "relevance",
      sortOrder: "descending",
    });
  });

  it("builds the query without letting a word change its shape", () => {
    expect(arxivSearchQuery("  a  b ")).toBe("all:a AND all:b");
    expect(arxivSearchQuery("ti:evil OR (x)")).toBe("all:tievil AND all:x");
    expect(arxivSearchQuery('AND OR ANDNOT "" ()')).toBeUndefined();
    expect(arxivSearchQuery("   ")).toBeUndefined();
  });

  it("reads the Atom feed: one line titles and summaries, the abstract page on the secure address", async () => {
    const { get } = await stub(text(ATOM(ENTRIES), 200, "application/atom+xml"));
    const result = await arxivEngine({ get, sleep: async () => undefined }).search({
      query: "electron",
      limit: 5,
    });
    expect(result).toEqual({
      ok: true,
      hits: [
        {
          title: "Multi-Electron Production at High Transverse Momenta",
          url: "https://arxiv.org/abs/hep-ex/0307015v1",
          snippet: "Multi-electron events are searched for in ep collisions.",
          engine: "arxiv",
        },
        {
          title: "Second paper",
          url: "https://arxiv.org/abs/2401.00001v2",
          snippet: "Second summary.",
          engine: "arxiv",
        },
      ],
    });
  });

  it("an empty feed is an answer with no hits", async () => {
    const { get } = await stub(text(ATOM(""), 200, "application/atom+xml"));
    expect(
      await arxivEngine({ get, sleep: async () => undefined }).search({ query: "zzz", limit: 5 }),
    ).toEqual({ ok: true, hits: [] });
  });

  it("the documented error entry is a refusal that carries arXiv's own explanation", async () => {
    const error = ATOM(`<entry>
      <id>http://arxiv.org/api/errors#incorrect_id_format_for_1234.12345</id>
      <title>Error</title>
      <summary>incorrect id format for 1234.12345</summary>
    </entry>`);
    const { get } = await stub(text(error, 200, "application/atom+xml"));
    expect(
      await arxivEngine({ get, sleep: async () => undefined }).search({ query: "x", limit: 5 }),
    ).toEqual({
      ok: false,
      reason: "arXiv refused the search: incorrect id format for 1234.12345",
    });
  });

  it("malformed XML and anything that is not an Atom feed fail closed", async () => {
    for (const [body, reason] of [
      [
        "<feed xmlns='http://www.w3.org/2005/Atom'><entry>",
        "arXiv answered with something that is not well-formed XML",
      ],
      ["not xml at all", "arXiv answered with something that is not well-formed XML"],
      [
        "<html xmlns='http://www.w3.org/1999/xhtml'/>",
        "arXiv answered in a format that was not expected (no Atom feed)",
      ],
      ["<feed><entry/></feed>", "arXiv answered in a format that was not expected (no Atom feed)"],
    ] as const) {
      const { get } = await stub(text(body, 200, "application/atom+xml"));
      expect(
        await arxivEngine({ get, sleep: async () => undefined }).search({ query: "x", limit: 5 }),
      ).toEqual({ ok: false, reason });
    }
  });

  it("HTTP 429 suspends it; 403 suspends it longer", async () => {
    for (const [status, suspendSeconds, reason] of [
      [429, 180, "too many requests"],
      [403, 3600, "access denied"],
    ] as const) {
      const { get } = await stub(text("no", status));
      expect(
        await arxivEngine({ get, sleep: async () => undefined }).search({ query: "x", limit: 5 }),
      ).toEqual({ ok: false, reason, suspendSeconds });
    }
  });

  it("one request at a time, at least three seconds after the previous one ended (arXiv's terms of use)", async () => {
    let inFlight = 0;
    let most = 0;
    const { get } = await stub((req, res) => {
      inFlight++;
      most = Math.max(most, inFlight);
      setTimeout(() => {
        inFlight--;
        text(ATOM(ENTRIES), 200, "application/atom+xml")(req, res);
      }, 20);
    });
    let now = 1_000_000;
    const slept: number[] = [];
    const engine = arxivEngine({
      get,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    expect(ARXIV_INTERVAL_MS).toBe(3000);
    await Promise.all([1, 2, 3].map((n) => engine.search({ query: `q${n}`, limit: 2 })));
    expect(most).toBe(1);
    // The first goes at once; each of the others waits the full interval (the clock stands still while a request runs).
    expect(slept).toEqual([3000, 3000]);
  });

  it("the pacer waits only what is left of the interval", async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new Pacer(
      3000,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    await pacer.run(async () => {
      now += 1000;
    });
    await pacer.run(async () => undefined);
    expect(slept).toEqual([3000]);
    now += 5000;
    await pacer.run(async () => undefined);
    expect(slept).toEqual([3000]);
  });
});

describe("Stack Overflow", () => {
  const items = [
    {
      title: "How to center a &lt;div&gt; in CSS? &#39;quoted&#39;",
      link: "https://stackoverflow.com/questions/1/how-to-center",
      score: 12,
      answer_count: 3,
      is_answered: true,
      tags: ["css", "html"],
    },
    {
      title: "Second",
      link: "javascript:alert(1)",
    },
    {
      title: "Third",
      link: "https://stackoverflow.com/questions/3/third",
      answer_count: 1,
    },
  ];

  it("asks api.stackexchange.com 2.3 search/advanced with the honest name and the query encoded", async () => {
    const { site, get } = await stub(json({ items: [], quota_remaining: 250 }));
    await stackOverflowEngine({ get }).search({ query: "c++ & #include?", limit: 7 });
    const request = site.requests[0];
    expect(request?.headers["user-agent"]).toBe(HONEST);
    expect(request?.headers.host).toBe("api.stackexchange.com");
    expect(request?.url.startsWith("/2.3/search/advanced?")).toBe(true);
    expect(Object.fromEntries(query(request?.url ?? ""))).toEqual({
      q: "c++ & #include?",
      site: "stackoverflow",
      order: "desc",
      sort: "relevance",
      pagesize: "7",
    });
  });

  it("reads a gzip-compressed answer, decodes the title, drops a link that is not http(s)", async () => {
    const { get } = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ items, quota_remaining: 200, has_more: false })));
    });
    expect(await stackOverflowEngine({ get }).search({ query: "center", limit: 5 })).toEqual({
      ok: true,
      hits: [
        {
          title: "How to center a <div> in CSS? 'quoted'",
          url: "https://stackoverflow.com/questions/1/how-to-center",
          snippet: "score 12; 3 answers; has an accepted or upvoted answer; tags: css, html",
          engine: "stackoverflow",
        },
        {
          title: "Third",
          url: "https://stackoverflow.com/questions/3/third",
          snippet: "1 answer",
          engine: "stackoverflow",
        },
      ],
    });
  });

  it("honours `backoff`: the hits are kept and the engine is left alone for that many seconds", async () => {
    const { get } = await stub(json({ items, backoff: 30, quota_remaining: 200 }));
    const result = await stackOverflowEngine({ get }).search({ query: "x", limit: 5 });
    expect(result).toMatchObject({
      ok: true,
      suspend: { seconds: 30, reason: "the API asked callers to wait 30 s (backoff)" },
    });
    expect(result.ok && result.hits).toHaveLength(2);
  });

  it("a backoff that is absurd is cut to a day", async () => {
    const { get } = await stub(json({ items: [], backoff: 99_999_999 }));
    expect(await stackOverflowEngine({ get }).search({ query: "x", limit: 5 })).toMatchObject({
      ok: true,
      suspend: { seconds: 86_400 },
    });
  });

  it("a quota that is used up suspends the engine", async () => {
    const { get } = await stub(json({ items, quota_remaining: 0 }));
    expect(await stackOverflowEngine({ get }).search({ query: "x", limit: 5 })).toMatchObject({
      ok: true,
      suspend: { seconds: 3600, reason: "the daily quota of the API is used up" },
    });
  });

  it("an error object is a refusal; throttle_violation (and 429) stop the asking", async () => {
    const throttle = await stub(
      json(
        {
          error_id: 502,
          error_name: "throttle_violation",
          error_message: "too many requests from this IP",
        },
        400,
      ),
    );
    expect(
      await stackOverflowEngine({ get: throttle.get }).search({ query: "x", limit: 5 }),
    ).toEqual({
      ok: false,
      reason:
        "Stack Overflow refused the search (throttle_violation: too many requests from this IP)",
      suspendSeconds: 3600,
    });
    const other = await stub(
      json({ error_id: 400, error_name: "bad_parameter", error_message: "q" }, 400),
    );
    expect(await stackOverflowEngine({ get: other.get }).search({ query: "x", limit: 5 })).toEqual({
      ok: false,
      reason: "Stack Overflow refused the search (bad_parameter: q)",
    });
  });

  it("HTTP statuses without a JSON body, and answers of another shape, fail closed", async () => {
    const tooMany = await stub(text("slow down", 429));
    expect(
      await stackOverflowEngine({ get: tooMany.get }).search({ query: "x", limit: 5 }),
    ).toEqual({
      ok: false,
      reason: "too many requests",
      suspendSeconds: 180,
    });
    const html = await stub(text("<html>error</html>", 200, "text/html"));
    expect(await stackOverflowEngine({ get: html.get }).search({ query: "x", limit: 5 })).toEqual({
      ok: false,
      reason: "Stack Overflow answered in a format that was not expected",
    });
    const noItems = await stub(json({ quota_remaining: 5 }));
    expect(
      await stackOverflowEngine({ get: noItems.get }).search({ query: "x", limit: 5 }),
    ).toEqual({
      ok: false,
      reason: "Stack Overflow answered in a format that was not expected",
    });
  });
});

describe("the way out: createDirectGet", () => {
  it("only https addresses are used", async () => {
    const get = createDirectGet({ userAgent: HONEST, dial: async () => connect({ port: 1 }) });
    await expect(get("http://en.wikipedia.org/")).rejects.toThrow(/only https/);
  });

  it("an answer that is too large is refused", async () => {
    const site = await localSite(text("x".repeat(5000)));
    sites.push(site);
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      maxBytes: 1000,
      dial: async () => connect({ host: "127.0.0.1", port: site.port }),
    });
    await expect(get("https://api.stackexchange.com/")).rejects.toThrow(/larger than 1000 bytes/);
  });

  it("an answer that never comes is given up on", async () => {
    const site = await localSite(() => undefined);
    sites.push(site);
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      timeoutMs: 150,
      dial: async () => connect({ host: "127.0.0.1", port: site.port }),
    });
    await expect(get("https://export.arxiv.org/")).rejects.toThrow(/no answer in 0.15 s/);
  });

  it("a redirect is not followed (an answer we do not understand)", async () => {
    const site = await localSite((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/" });
      res.end();
    });
    sites.push(site);
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      dial: async () => connect({ host: "127.0.0.1", port: site.port }),
    });
    const response = await get("https://en.wikipedia.org/w/api.php");
    expect(response.status).toBe(302);
    expect(site.requests).toHaveLength(1);
  });

  it("goes out through the egress proxy with CONNECT to the exact host and port", async () => {
    const site = await localSite(json({ query: { search: [] } }));
    sites.push(site);
    const { createServer } = await import("node:http");
    const asked: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => {
      asked.push(req.url ?? "");
      const upstream = connect({ host: "127.0.0.1", port: site.port }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    sites.push({
      close: () =>
        new Promise<void>((done) => {
          proxy.close(() => done());
          proxy.closeAllConnections();
        }),
    });
    const address = proxy.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      proxy: { host: "127.0.0.1", port },
    });
    const response = await get("https://en.wikipedia.org/w/api.php?action=query");
    expect(response.status).toBe(200);
    expect(asked).toEqual(["en.wikipedia.org:443"]);
    expect(site.requests[0]?.headers["user-agent"]).toBe(HONEST);
  });

  it("speaks TLS to the host it named (certificate checked against the host name), through the proxy", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer: createTlsServer } = await import("node:https");
    const { createServer } = await import("node:http");
    const dir = mkdtempSync(join(tmpdir(), "suup-tls-"));
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-keyout",
          join(dir, "k.pem"),
          "-out",
          join(dir, "c.pem"),
          "-subj",
          "/CN=en.wikipedia.org",
          "-addext",
          "subjectAltName=DNS:en.wikipedia.org",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(join(dir, "c.pem"), "utf8");
      const origin = createTlsServer(
        { key: readFileSync(join(dir, "k.pem")), cert },
        (req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ua: req.headers["user-agent"], host: req.headers.host }));
        },
      );
      await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
      sites.push({
        close: () =>
          new Promise<void>((done) => {
            origin.close(() => done());
            origin.closeAllConnections();
          }),
      });
      const originAddress = origin.address();
      const originPort =
        typeof originAddress === "object" && originAddress !== null ? originAddress.port : 0;
      const proxy = createServer();
      const opened: { destroy(): void }[] = [];
      proxy.on("connect", (_req, socket) => {
        opened.push(socket);
        const upstream = connect({ host: "127.0.0.1", port: originPort }, () => {
          opened.push(upstream);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
      });
      await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
      sites.push({
        close: () =>
          new Promise<void>((done) => {
            for (const socket of opened) socket.destroy();
            proxy.close(() => done());
            proxy.closeAllConnections();
          }),
      });
      const address = proxy.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const get = createDirectGet({
        userAgent: HONEST,
        proxy: { host: "127.0.0.1", port },
        ca: cert,
      });
      const response = await get("https://en.wikipedia.org/w/api.php");
      expect(JSON.parse(response.body)).toEqual({ ua: HONEST, host: "en.wikipedia.org" });
      // A certificate for another name is refused.
      const wrong = createDirectGet({
        userAgent: HONEST,
        proxy: { host: "127.0.0.1", port },
        ca: cert,
      });
      await expect(wrong("https://export.arxiv.org/")).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a proxy that refuses the host gives a clear message", async () => {
    const { createServer } = await import("node:http");
    const proxy = createServer();
    proxy.on("connect", (_req, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    sites.push({
      close: () =>
        new Promise<void>((done) => {
          proxy.close(() => done());
          proxy.closeAllConnections();
        }),
    });
    const address = proxy.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const get = createDirectGet({
      userAgent: HONEST,
      secure: false,
      proxy: { host: "127.0.0.1", port },
    });
    await expect(get("https://evil.example/")).rejects.toThrow(
      /the egress proxy refused evil.example:443 \(HTTP 403\)/,
    );
  });

  it("the real egress proxy, with the exact hosts of the direct engines, refuses anything else (GitHub among it)", async () => {
    const hosts = new Set(engineHosts(DEFAULT_ENGINES, ["en", "pt"]));
    expect([...hosts].sort()).toEqual([
      "api.search.brave.com",
      "api.stackexchange.com",
      "api.tavily.com",
      "en.wikipedia.org",
      "export.arxiv.org",
      "pt.wikipedia.org",
    ]);
    const refused: string[] = [];
    const proxy = new EgressProxy({
      policy: { allowedHosts: async () => hosts },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
      onEvent: (event) => {
        if (event.decision === "refused") refused.push(event.host);
      },
    });
    const { port } = await proxy.start();
    sites.push({ close: () => proxy.stop() });
    const get = createDirectGet({ userAgent: HONEST, proxy: { host: "127.0.0.1", port } });
    for (const host of ["api.github.com", "evil.example", "wikipedia.org", "es.wikipedia.org"]) {
      await expect(get(`https://${host}/`)).rejects.toThrow(/the egress proxy refused/);
    }
    expect(refused).toEqual([
      "api.github.com",
      "evil.example",
      "wikipedia.org",
      "es.wikipedia.org",
    ]);
  });

  it("a host off the list is said to be off the engines' list, by the proxy's own code", async () => {
    const hosts = new Set(engineHosts(DEFAULT_ENGINES, ["en", "pt"]));
    const proxy = new EgressProxy({
      policy: { allowedHosts: async () => hosts },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
    });
    const { port } = await proxy.start();
    sites.push({ close: () => proxy.stop() });
    const get = createDirectGet({ userAgent: HONEST, proxy: { host: "127.0.0.1", port } });
    await expect(get("https://api.github.com/")).rejects.toThrow(
      "the egress proxy refused api.github.com:443 (HTTP 403); the host is not on the engines' list",
    );
  });

  it("on a computer without DNS, a host ON the list is reported as unresolved, not as off the list", async () => {
    const hosts = new Set(engineHosts(DEFAULT_ENGINES, ["en", "pt"]));
    expect(hosts.has("pt.wikipedia.org")).toBe(true);
    const refused: { host: string; reason: string | undefined }[] = [];
    const proxy = new EgressProxy({
      policy: { allowedHosts: async () => hosts },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
      resolver: {
        async resolve() {
          throw new Error("getaddrinfo EAI_AGAIN");
        },
      },
      onEvent: (event) => {
        if (event.decision === "refused") refused.push({ host: event.host, reason: event.reason });
      },
    });
    const { port } = await proxy.start();
    sites.push({ close: () => proxy.stop() });
    const get = createDirectGet({ userAgent: HONEST, proxy: { host: "127.0.0.1", port } });
    const error = await get("https://pt.wikipedia.org/w/api.php").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "the egress proxy refused pt.wikipedia.org:443 (HTTP 403); the host name could not be resolved (no DNS answer on this computer)",
    );
    expect((error as Error).message).not.toContain("engines' list");
    expect(refused).toEqual([{ host: "pt.wikipedia.org", reason: "dns_failed" }]);
  });

  it("the real proxy's other refusals keep their own reason (private address, list not available)", async () => {
    const hosts = new Set(["en.wikipedia.org"]);
    const privateAnswer = new EgressProxy({
      policy: { allowedHosts: async () => hosts },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
      resolver: { resolve: async () => ["10.0.0.5"] },
    });
    const down = new EgressProxy({
      policy: {
        allowedHosts: async () => {
          throw new Error("restarting");
        },
      },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
    });
    const first = await privateAnswer.start();
    sites.push({ close: () => privateAnswer.stop() });
    const second = await down.start();
    sites.push({ close: () => down.stop() });
    const viaPrivate = createDirectGet({
      userAgent: HONEST,
      proxy: { host: "127.0.0.1", port: first.port },
    });
    await expect(viaPrivate("https://en.wikipedia.org/")).rejects.toThrow(
      "the egress proxy refused en.wikipedia.org:443 (HTTP 403); the host name resolves to an address that is never reachable (private, loopback, link-local or metadata)",
    );
    const viaDown = createDirectGet({
      userAgent: HONEST,
      proxy: { host: "127.0.0.1", port: second.port },
    });
    await expect(viaDown("https://en.wikipedia.org/")).rejects.toThrow(
      "the egress proxy refused en.wikipedia.org:443 (HTTP 403); the list of allowed hosts is not available right now; try again in a moment",
    );
  });

  it("a refusal without a known code reports only the status, with no claim about the list", async () => {
    const { createServer } = await import("node:http");
    for (const header of [
      "",
      "X-Suup-Egress-Reason: not_a_code\r\n",
      "X-Suup-Egress-Reason: DNS_FAILED\r\n",
    ]) {
      const proxy = createServer();
      proxy.on("connect", (_req, socket) => {
        socket.end(`HTTP/1.1 403 Forbidden\r\n${header}\r\n`);
      });
      await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
      sites.push({
        close: () =>
          new Promise<void>((done) => {
            proxy.close(() => done());
            proxy.closeAllConnections();
          }),
      });
      const address = proxy.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const get = createDirectGet({
        userAgent: HONEST,
        secure: false,
        proxy: { host: "127.0.0.1", port },
      });
      const error = await get("https://evil.example/").then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as Error).message, header).toBe(
        "the egress proxy refused evil.example:443 (HTTP 403)",
      );
    }
  });
});

/** Engines for the search flow: each answers what the table says and counts its calls. */
function fake(
  id: string,
  answer: () => ReturnType<DirectEngine["search"]>,
): DirectEngine & { calls: number } {
  const engine = {
    id,
    calls: 0,
    async search() {
      engine.calls++;
      return await answer();
    },
  };
  return engine;
}

const hit = (engine: string, n: number) => ({
  title: `${engine} ${n}`,
  url: `https://${engine}.example/${n}`,
  snippet: "s",
  engine,
});

describe("the search with the engines Suup asks itself", () => {
  it("merges the engines' lists in turns, once per URL, and says which engines answered", async () => {
    const wiki = fake("wikipedia", async () => ({
      ok: true,
      hits: [hit("wikipedia", 1), hit("wikipedia", 2)],
    }));
    const arxiv = fake("arxiv", async () => ({
      ok: true,
      hits: [hit("arxiv", 1), hit("wikipedia", 1)],
    }));
    const search = createSearch({ engines: ["wikipedia", "arxiv"], direct: [wiki, arxiv] });
    const out = await search({ query: "x", limit: 10 });
    expect(out).toMatchObject({ ok: true, engines: ["wikipedia", "arxiv"], suspended: [] });
    expect(out.ok && out.hits.map((h) => h.url)).toEqual([
      "https://wikipedia.example/1",
      "https://arxiv.example/1",
      "https://wikipedia.example/2",
    ]);
  });

  it("an engine that says to stop is left alone for the time it said (the governor remembers)", async () => {
    let now = 1_700_000_000_000;
    const governor = new SearchGovernor({ now: () => now, sleep: async () => undefined });
    const so = fake("stackoverflow", async () => ({
      ok: true,
      hits: [hit("stackoverflow", 1)],
      suspend: { seconds: 30, reason: "the API asked callers to wait 30 s (backoff)" },
    }));
    const wiki = fake("wikipedia", async () => ({ ok: true, hits: [hit("wikipedia", 1)] }));
    const search = createSearch({
      engines: ["wikipedia", "stackoverflow"],
      direct: [wiki, so],
      governor,
      now: () => now,
    });
    const first = await search({ query: "one" });
    expect(first).toMatchObject({
      ok: true,
      suspended: [
        {
          engine: "stackoverflow",
          reason: "the API asked callers to wait 30 s (backoff)",
          retryInSeconds: 30,
        },
      ],
    });
    expect(first.ok && first.hits).toHaveLength(2);
    now += 10_000;
    const second = await search({ query: "two" });
    expect(so.calls).toBe(1);
    expect(second).toMatchObject({
      ok: true,
      suspended: [
        {
          engine: "stackoverflow",
          reason: "the API asked callers to wait 30 s (backoff)",
          retryInSeconds: 20,
        },
      ],
    });
    now += 25_000;
    await search({ query: "three" });
    expect(so.calls).toBe(2);
  });

  it("a refusal with a window suspends; a failure without one does not", async () => {
    let now = 1_700_000_000_000;
    const governor = new SearchGovernor({ now: () => now, sleep: async () => undefined });
    const denied = fake("arxiv", async () => ({
      ok: false,
      reason: "access denied",
      suspendSeconds: 3600,
    }));
    const flaky = fake("wikipedia", async () => ({ ok: false, reason: "no answer in 15 s" }));
    const search = createSearch({
      engines: ["wikipedia", "arxiv"],
      direct: [flaky, denied],
      governor,
      now: () => now,
    });
    const first = await search({ query: "a" });
    expect(first).toMatchObject({
      ok: true,
      hits: [],
      suspended: [
        { engine: "wikipedia", reason: "no answer in 15 s" },
        { engine: "arxiv", reason: "access denied", retryInSeconds: 3600 },
      ],
    });
    now += 1000;
    await search({ query: "b" });
    expect(flaky.calls).toBe(2);
    expect(denied.calls).toBe(1);
  });

  it("an engine that throws is a failure of that engine only", async () => {
    const bad = fake("arxiv", async () => {
      throw new Error("kaput");
    });
    const wiki = fake("wikipedia", async () => ({ ok: true, hits: [hit("wikipedia", 1)] }));
    const out = await createSearch({ engines: ["wikipedia", "arxiv"], direct: [wiki, bad] })({
      query: "x",
    });
    expect(out).toMatchObject({ ok: true, suspended: [{ engine: "arxiv", reason: "kaput" }] });
  });

  it("the cache still answers an identical search without asking any engine", async () => {
    const now = 1_700_000_000_000;
    const wiki = fake("wikipedia", async () => ({ ok: true, hits: [hit("wikipedia", 1)] }));
    const search = createSearch({
      engines: ["wikipedia"],
      direct: [wiki],
      cache: memorySearchCache(),
      now: () => now,
    });
    await search({ query: "Hello  World" });
    const again = await search({ query: "hello world" });
    expect(wiki.calls).toBe(1);
    expect(again).toMatchObject({ ok: true, cached: { ageSeconds: 0 } });
  });

  it("the limits per engine still apply: the engine over its limit is left out and said so", async () => {
    const now = 1_700_000_000_000;
    const governor = new SearchGovernor({
      now: () => now,
      sleep: async () => undefined,
      limits: { perEngine: { arxiv: 1 } },
    });
    const arxiv = fake("arxiv", async () => ({ ok: true, hits: [hit("arxiv", 1)] }));
    const wiki = fake("wikipedia", async () => ({ ok: true, hits: [hit("wikipedia", 1)] }));
    const search = createSearch({
      engines: ["wikipedia", "arxiv"],
      direct: [wiki, arxiv],
      governor,
      now: () => now,
    });
    await search({ query: "one" });
    const second = await search({ query: "two" });
    expect(arxiv.calls).toBe(1);
    expect(second).toMatchObject({
      ok: true,
      throttled: [{ engine: "arxiv" }],
      engines: ["wikipedia"],
    });
  });
});

describe("the services without Docker", () => {
  const missing = "/nonexistent/suup-docker";

  it("start the engines on their own egress proxy, with no Docker and no container", async () => {
    const services = await startWebServices({
      dockerPath: missing,
      readerEnabled: false,
      languages: ["en", "pt"],
    });
    try {
      expect(services.direct.map((e) => e.id)).toEqual([
        "wikipedia",
        "arxiv",
        "stackoverflow",
        "tavily",
        "brave",
      ]);
      expect(services.searchProblem).toBeUndefined();
      expect(services.directProxy?.host).toBe("127.0.0.1");
      // The proxy's list is the engines' exact hosts, the general ones included.
      expect(engineHosts(DEFAULT_ENGINES, ["en", "pt"])).toEqual([
        "api.search.brave.com",
        "api.stackexchange.com",
        "api.tavily.com",
        "en.wikipedia.org",
        "export.arxiv.org",
        "pt.wikipedia.org",
      ]);
    } finally {
      await services.stop();
    }
  });

  it("the search is ready without Docker", async () => {
    const services = await startWebServices({
      dockerPath: missing,
      readerEnabled: false,
      engines: ["wikipedia", "arxiv", "stackoverflow"],
      languages: ["en"],
    });
    try {
      expect(services.searchProblem).toBeUndefined();
      const web = createWebAccess({
        searchEnabled: true,
        readerEnabled: false,
        services: async () => services,
      });
      expect(await web.status()).toMatchObject({
        search: "ready",
        engines: ["wikipedia", "arxiv", "stackoverflow"],
      });
    } finally {
      await services.stop();
    }
  });

  it("the proxy of the direct engines lets through only their exact hosts", async () => {
    const services = await startWebServices({
      dockerPath: missing,
      readerEnabled: false,
      languages: ["en", "pt"],
    });
    try {
      const proxy = services.directProxy;
      expect(proxy).toBeDefined();
      const get = createDirectGet({
        userAgent: HONEST,
        proxy: proxy as { host: string; port: number },
      });
      await expect(get("https://api.github.com/search/repositories?q=x")).rejects.toThrow(
        /the egress proxy refused api.github.com:443/,
      );
      await expect(get("https://html.duckduckgo.com/html/")).rejects.toThrow(/refused/);
      await expect(get("https://api.firecrawl.dev/v2/search")).rejects.toThrow(/refused/);
    } finally {
      await services.stop();
    }
  });

  it("the search through the web access works with the direct engines alone", async () => {
    const { get } = await stub(json({ query: { search: [{ title: "Turing", snippet: "s" }] } }));
    const services = await startWebServices({
      dockerPath: missing,
      readerEnabled: false,
      engines: ["wikipedia"],
      languages: ["en"],
      directGet: get as DirectGet,
    });
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      services: async () => services,
    });
    expect(await web.search({ query: "turing" })).toMatchObject({
      ok: true,
      hits: [{ url: "https://en.wikipedia.org/wiki/Turing", engine: "wikipedia" }],
    });
  });
});
