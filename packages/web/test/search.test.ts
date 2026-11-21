import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINES, ENGINES, engineHosts, unknownEngines } from "../src/engines.js";
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
    { url: "javascript:alert(1)", title: "bad", content: "x", engine: "github" },
    { url: "https://github.com/x/suup", title: "", content: "repo", engines: ["github"] },
    { url: "https://example.com/3", title: "three", content: "c", engine: "arxiv" },
  ],
  unresponsive_engines: [
    ["duckduckgo", "CAPTCHA"],
    ["brave", "Suspended: too many requests"],
  ],
});

describe("parseSearxAnswer", () => {
  it("returns title, url, snippet and engine, one line each, http(s) only, no duplicates", () => {
    const out = parseSearxAnswer(ANSWER, "suup", 10, ["wikipedia", "github"]);
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
        title: "https://github.com/x/suup",
        url: "https://github.com/x/suup",
        snippet: "repo",
        engine: "github",
      },
      { title: "three", url: "https://example.com/3", snippet: "c", engine: "arxiv" },
    ]);
  });

  it("reports which engines were suspended and returns what it has", () => {
    const out = parseSearxAnswer(ANSWER, "suup", 1, ["wikipedia"]);
    expect(out.ok && out.hits).toHaveLength(1);
    expect(out.ok && out.suspended).toEqual([
      { engine: "duckduckgo", reason: "CAPTCHA" },
      { engine: "brave", reason: "Suspended: too many requests" },
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
  it("the default list is only engines with a documented public API", () => {
    expect(DEFAULT_ENGINES).toEqual(["wikipedia", "arxiv", "stackoverflow", "github"]);
    for (const id of DEFAULT_ENGINES) expect(ENGINES.find((e) => e.id === id)?.access).toBe("api");
  });

  it("Google is not in the list at all", () => {
    expect(ENGINES.map((e) => e.id)).not.toContain("google");
    expect(ENGINES.map((e) => e.id)).not.toContain("bing");
  });

  it("lists exact host names, per language", () => {
    expect(engineHosts(["wikipedia", "github"], ["en", "pt"])).toEqual([
      "api.github.com",
      "en.wikipedia.org",
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
  it("without a proxy there is no proxies block", () => {
    expect(renderSearxSettings({ engines: ["wikipedia"] })).not.toContain("proxies");
  });
});
