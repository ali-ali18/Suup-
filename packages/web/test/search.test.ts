import { describe, expect, it } from "vitest";
import type { DirectEngine } from "../src/direct-engines.js";
import {
  DEFAULT_ENGINES,
  DEFAULT_GENERAL_ORDER,
  ENGINES,
  engineHosts,
  generalQueue,
  unknownEngines,
} from "../src/engines.js";
import { clip, createSearch } from "../src/search.js";

describe("createSearch", () => {
  it("refuses an empty query", async () => {
    const search = createSearch({ direct: [], engines: [] });
    expect(await search({ query: "   " })).toMatchObject({ ok: false });
  });

  it("caps the count to what was asked and to the configured maximum", async () => {
    const wiki: DirectEngine = {
      id: "wikipedia",
      search: async () => ({
        ok: true,
        hits: Array.from({ length: 8 }, (_, i) => ({
          title: `t${i}`,
          url: `https://w.example/${i}`,
          snippet: "",
          engine: "wikipedia",
        })),
      }),
    };
    const out = await createSearch({ direct: [wiki], engines: ["wikipedia"], maxResults: 6 })({
      query: "x",
      limit: 10,
    });
    expect(out.ok && out.hits).toHaveLength(6);
    const few = await createSearch({ direct: [wiki], engines: ["wikipedia"] })({ query: "x" });
    expect(few.ok && few.hits).toHaveLength(5);
  });
});

describe("clip", () => {
  it("makes one line and cuts with an ellipsis", () => {
    expect(clip("a\n\n b\t c", 50)).toBe("a b c");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("engines", () => {
  it("the default list is the three specialised APIs and the two general ones of the queue", () => {
    expect(DEFAULT_ENGINES).toEqual(["wikipedia", "arxiv", "stackoverflow", "tavily", "brave"]);
    expect(ENGINES.filter((e) => e.general).map((e) => e.id)).toEqual(["tavily", "brave"]);
    // DuckDuckGo, SearXNG's engines, Google, Bing and Firecrawl are not in the list at all.
    expect(unknownEngines(["duckduckgo", "startpage", "google", "bing", "firecrawl"])).toEqual([
      "duckduckgo",
      "startpage",
      "google",
      "bing",
      "firecrawl",
    ]);
  });

  it("the general engines need a key; the specialised ones do not", () => {
    for (const engine of ENGINES) expect(engine.key !== undefined).toBe(engine.general);
    expect(ENGINES.find((e) => e.id === "tavily")?.key).toEqual({
      defaultEnv: "TAVILY_API_KEY",
      defaultSecret: "TAVILY_API_KEY",
    });
    expect(ENGINES.find((e) => e.id === "brave")?.key).toEqual({
      defaultEnv: "BRAVE_SEARCH_API_KEY",
      defaultSecret: "BRAVE_SEARCH_API_KEY",
    });
  });

  it("Brave is the only engine whose results may not be cached nor used in AI evaluations (its terms)", () => {
    expect(ENGINES.filter((e) => !e.cacheable).map((e) => e.id)).toEqual(["brave"]);
    expect(ENGINES.filter((e) => e.forbiddenInEvals).map((e) => e.id)).toEqual(["brave"]);
  });

  it("GitHub is not a web search engine (GitHub search is the GitHub MCP connector's)", () => {
    expect(ENGINES.map((e) => e.id)).not.toContain("github");
    expect(unknownEngines(["github"])).toEqual(["github"]);
    expect(engineHosts(["github", ...DEFAULT_ENGINES], ["en", "pt"])).not.toContain(
      "api.github.com",
    );
  });

  it("the egress hosts are exactly the API hosts of the research, per language", () => {
    expect(engineHosts(DEFAULT_ENGINES, ["en", "pt"])).toEqual([
      "api.search.brave.com",
      "api.stackexchange.com",
      "api.tavily.com",
      "en.wikipedia.org",
      "export.arxiv.org",
      "pt.wikipedia.org",
    ]);
    expect(engineHosts(["tavily"], ["en"])).toEqual(["api.tavily.com"]);
    expect(engineHosts(["brave"], ["en"])).toEqual(["api.search.brave.com"]);
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

describe("the queue order", () => {
  it("is Tavily, then Brave, by default", () => {
    expect(DEFAULT_GENERAL_ORDER).toEqual(["tavily", "brave"]);
    expect(generalQueue(DEFAULT_ENGINES)).toEqual(["tavily", "brave"]);
  });

  it("follows the configured order, only for the engines that are on", () => {
    expect(generalQueue(DEFAULT_ENGINES, ["brave", "tavily"])).toEqual(["brave", "tavily"]);
    expect(generalQueue(["wikipedia", "brave"], ["tavily", "brave"])).toEqual(["brave"]);
    expect(generalQueue(["wikipedia", "arxiv"])).toEqual([]);
  });

  it("an engine left out of the order goes after, in the default order, and a repeat counts once", () => {
    expect(generalQueue(DEFAULT_ENGINES, ["brave"])).toEqual(["brave", "tavily"]);
    expect(generalQueue(DEFAULT_ENGINES, ["brave", "brave", "tavily"])).toEqual([
      "brave",
      "tavily",
    ]);
  });
});
