import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGINES,
  directEngineIds,
  ENGINES,
  engineHosts,
  searxEngineIds,
  unknownEngines,
} from "../src/engines.js";
import { clip, createSearch, parseSearxAnswer, type SearxBackend } from "../src/search.js";
import { renderSearxSettings } from "../src/searx-settings.js";

const ANSWER = JSON.stringify({
  query: "suup",
  results: [
    {
      url: "https://en.wikipedia.org/wiki/Suup",
      title: "Suup — Wikipedia",
      content: "A  bot\nplatform.\u0000",
      engine: "wikipedia",
    },
    { url: "https://en.wikipedia.org/wiki/Suup", title: "dup", content: "", engine: "arxiv" },
    { url: "javascript:alert(1)", title: "bad", content: "x", engine: "duckduckgo" },
    { url: "https://example.org/x/suup", title: "", content: "repo", engines: ["duckduckgo"] },
    { url: "https://example.com/3", title: "three", content: "c", engine: "arxiv" },
  ],
  unresponsive_engines: [
    ["duckduckgo", "CAPTCHA"],
    ["stackoverflow", "Suspended: too many requests"],
  ],
});

describe("parseSearxAnswer", () => {
  it("returns title, url, snippet and engine, one line each, http(s) only, no duplicates", () => {
    const out = parseSearxAnswer(ANSWER, "suup", 10, ["wikipedia", "duckduckgo"]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.hits).toEqual([
      {
        title: "Suup — Wikipedia",
        url: "https://en.wikipedia.org/wiki/Suup",
        snippet: "A bot platform.",
        engine: "wikipedia",
      },
      {
        title: "https://example.org/x/suup",
        url: "https://example.org/x/suup",
        snippet: "repo",
        engine: "duckduckgo",
      },
      { title: "three", url: "https://example.com/3", snippet: "c", engine: "arxiv" },
    ]);
  });

  it("reports which engines were suspended and returns what it has", () => {
    const out = parseSearxAnswer(ANSWER, "suup", 1, ["wikipedia"]);
    expect(out.ok && out.hits).toHaveLength(1);
    expect(out.ok && out.suspended).toEqual([
      { engine: "duckduckgo", reason: "CAPTCHA" },
      { engine: "stackoverflow", reason: "Suspended: too many requests" },
    ]);
  });

  it("handles an answer with no results", () => {
    const out = parseSearxAnswer(
      '{"results":[],"unresponsive_engines":[["wikipedia","timeout"]]}',
      "q",
      5,
      ["wikipedia"],
    );
    expect(out).toMatchObject({
      ok: true,
      hits: [],
      suspended: [{ engine: "wikipedia", reason: "timeout" }],
    });
  });

  it("refuses an answer that is not JSON or not the expected shape", () => {
    expect(parseSearxAnswer("<html>403</html>", "q", 5, [])).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(parseSearxAnswer('{"results":"nope"}', "q", 5, [])).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });
});

describe("createSearch", () => {
  it("sends the query as JSON for the engines, with language and range, and caps the count", async () => {
    let seen: URLSearchParams | undefined;
    const backend: SearxBackend = {
      async query(params) {
        seen = params;
        return ANSWER;
      },
    };
    const search = createSearch({ backend, engines: ["wikipedia"], maxResults: 2 });
    const out = await search({ query: " suup ", limit: 50, language: "pt", timeRange: "year" });
    expect(seen?.get("q")).toBe("suup");
    expect(seen?.get("engines")).toBe("wikipedia");
    expect(seen?.get("format")).toBe("json");
    expect(seen?.get("language")).toBe("pt");
    expect(seen?.get("time_range")).toBe("year");
    expect(out.ok && out.hits).toHaveLength(2);
  });

  it("says the service is unavailable when the backend fails", async () => {
    const search = createSearch({
      backend: {
        async query() {
          throw new Error("connection refused");
        },
      },
      engines: [],
    });
    expect(await search({ query: "x" })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("refuses an empty query", async () => {
    const search = createSearch({ backend: { query: async () => ANSWER }, engines: [] });
    expect(await search({ query: "   " })).toMatchObject({ ok: false });
  });
});

describe("clip", () => {
  it("makes one line and cuts with an ellipsis", () => {
    expect(clip("a\n\n b\t c", 50)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("engines", () => {
  it("the default list is the three public APIs Suup asks itself and DuckDuckGo, the one general engine the owner turned on", () => {
    expect(DEFAULT_ENGINES).toEqual(["wikipedia", "arxiv", "stackoverflow", "duckduckgo"]);
    for (const id of DEFAULT_ENGINES.filter((e) => e !== "duckduckgo")) {
      expect(ENGINES.find((e) => e.id === id)?.access).toBe("api");
      expect(ENGINES.find((e) => e.id === id)?.via).toBe("direct");
    }
    // DuckDuckGo is the only general engine; Google, Bing, Brave and Startpage are not in the list.
    expect(ENGINES.filter((e) => e.general).map((e) => e.id)).toEqual(["duckduckgo"]);
    expect(unknownEngines(["brave", "startpage"])).toEqual(["brave", "startpage"]);
    expect(ENGINES.filter((e) => e.general && e.defaultOn).map((e) => e.id)).toEqual([
      "duckduckgo",
    ]);
  });

  it("only DuckDuckGo is left to SearXNG by default; the APIs are asked directly", () => {
    expect(searxEngineIds(DEFAULT_ENGINES)).toEqual(["duckduckgo"]);
    expect(directEngineIds(DEFAULT_ENGINES)).toEqual(["wikipedia", "arxiv", "stackoverflow"]);
    expect(searxEngineIds(["nope"])).toEqual([]);
  });

  it("GitHub is not a web search engine (GitHub search is the GitHub MCP connector's)", () => {
    expect(ENGINES.map((e) => e.id)).not.toContain("github");
    expect(unknownEngines(["github"])).toEqual(["github"]);
    expect(engineHosts(["github", ...DEFAULT_ENGINES], ["en", "pt"])).not.toContain(
      "api.github.com",
    );
  });

  it("DuckDuckGo's egress hosts are exactly the one its engine module posts to, and its rate is low", () => {
    // From searx/engines/duckduckgo.py of the pinned image: `ddg_url = "https://html.duckduckgo.com/html/"`.
    expect(engineHosts(["duckduckgo"], ["en"])).toEqual(["html.duckduckgo.com"]);
    expect(engineHosts(DEFAULT_ENGINES, ["en", "pt"])).toEqual([
      "api.stackexchange.com",
      "en.wikipedia.org",
      "export.arxiv.org",
      "html.duckduckgo.com",
      "pt.wikipedia.org",
    ]);
    expect(ENGINES.find((e) => e.id === "duckduckgo")?.perMinute).toBeLessThanOrEqual(6);
  });

  it("the hosts of the engines Suup asks itself are exactly the API hosts of the research", () => {
    expect(engineHosts(directEngineIds(DEFAULT_ENGINES), ["en", "pt"])).toEqual([
      "api.stackexchange.com",
      "en.wikipedia.org",
      "export.arxiv.org",
      "pt.wikipedia.org",
    ]);
  });

  it("Google is not in the list at all", () => {
    expect(ENGINES.map((e) => e.id)).not.toContain("google");
    expect(ENGINES.map((e) => e.id)).not.toContain("bing");
  });

  it("lists exact host names, per language", () => {
    expect(engineHosts(["wikipedia", "arxiv"], ["en", "pt"])).toEqual([
      "en.wikipedia.org",
      "export.arxiv.org",
      "pt.wikipedia.org",
    ]);
    expect(engineHosts(["nope"], ["en"])).toEqual([]);
    expect(unknownEngines(["wikipedia", "google"])).toEqual(["google"]);
  });
});

describe("renderSearxSettings", () => {
  const text = renderSearxSettings({
    engines: ["wikipedia", "arxiv"],
    proxyUrl: "http://172.29.78.1:3129",
  });
  it("turns JSON on, the limiter off, and keeps only our engines", () => {
    expect(text).toContain("- json");
    expect(text).toContain("limiter: false");
    expect(text).toContain("keep_only:");
    expect(text).toContain('- "wikipedia"');
    expect(text).toContain('all://: "http://172.29.78.1:3129"');
  });
  it("holds no secret", () => {
    expect(text.split("\n").some((line) => line.trim().startsWith("secret_key:"))).toBe(false);
    expect(text).toContain("SEARXNG_SECRET");
  });
  it("gives DuckDuckGo the honest user agent, as a setting of its engine, and no other engine", () => {
    const withDdg = renderSearxSettings({
      engines: ["wikipedia", "duckduckgo"],
      userAgent: "SuupBot/0.1 (+https://example.org/suup)",
    });
    expect(withDdg).toContain(
      '  - name: "duckduckgo"\n    disabled: false\n    _HTTP_User_Agent: "SuupBot/0.1 (+https://example.org/suup)"\n',
    );
    expect(withDdg.split("_HTTP_User_Agent").length - 1).toBe(1);
    expect(renderSearxSettings({ engines: ["duckduckgo"] })).toContain(
      '_HTTP_User_Agent: "SuupBot/',
    );
  });
  it("without a proxy there is no proxies block", () => {
    expect(renderSearxSettings({ engines: ["wikipedia"] })).not.toContain("proxies");
  });
});
