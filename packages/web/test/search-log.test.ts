import { describe, expect, it } from "vitest";
import { createWebAccess, searchProblemLogLine } from "../src/service.js";

// A search that failed, or where engines did not answer, leaves one line in the logs with the reason
// (the owner's "a pesquisa deu erro" had nothing there to go on). Never the query.

describe("search problems in the logs", () => {
  it("a failed search: the reason and the message", () => {
    expect(
      searchProblemLogLine({
        ok: false,
        reason: "rate_limited",
        message: "Suup's search limit is used up.",
        retryInSeconds: 40,
      }),
    ).toBe("web_search: rate_limited: Suup's search limit is used up. retry_in=40s");
  });

  it("engines that did not answer, left out or all general engines down, without the query", () => {
    const line = searchProblemLogLine({
      ok: true,
      query: "meu segredo",
      hits: [],
      engines: ["duckduckgo", "wikipedia"],
      suspended: [{ engine: "duckduckgo", reason: "captcha", retryInSeconds: 3600 }],
      throttled: [{ engine: "arxiv", retryInSeconds: 3 }],
      generalUnavailable: { retryInSeconds: 3600 },
    });
    expect(line).toBe(
      "web_search: 0 results; duckduckgo did not answer (captcha, retry_in=3600s); arxiv left out by Suup's limit (retry_in=3s); no general web engine available",
    );
    expect(line).not.toContain("meu segredo");
  });

  it("a search where every engine answered: nothing in the log", () => {
    expect(
      searchProblemLogLine({
        ok: true,
        query: "q",
        hits: [],
        engines: ["wikipedia"],
        suspended: [],
      }),
    ).toBeUndefined();
  });

  it("the web access writes the line when the search service is not running", async () => {
    const lines: string[] = [];
    const web = createWebAccess({
      searchEnabled: true,
      readerEnabled: false,
      services: async () => ({ engines: [], searchProblem: "Docker is not running" }),
      log: (line) => lines.push(line),
    });
    const out = await web.search({ query: "q" });
    expect(out.ok).toBe(false);
    expect(lines).toEqual([
      "web_search: unavailable: The search service is not running (Docker is not running).",
    ]);
  });
});
