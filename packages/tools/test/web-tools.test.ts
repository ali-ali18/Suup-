import type {
  ToolContext,
  WebAccess,
  WebPage,
  WebReadOutcome,
  WebSearchOutcome,
  WebSearchRequest,
} from "@suup/core";
import { EXTERNAL_OPEN } from "@suup/core";
import { describe, expect, it } from "vitest";
import { formatRead, formatSearch } from "../src/index.js";
import { registry } from "./helpers.js";
import { localWorkspace } from "./local-helpers.js";

const PAGE: WebPage = {
  url: "https://example.com/final",
  requestedUrl: "https://example.com/start",
  status: 200,
  title: "A page",
  byline: "Ada",
  published: "2026-05-01",
  extraction: "readability",
  markdown: "# A page\n\nBody text.",
  truncated: false,
  fullLength: 20,
  rendered: false,
};

function web(
  over: Partial<WebAccess> = {},
): WebAccess & { searches: WebSearchRequest[]; reads: string[] } {
  const searches: WebSearchRequest[] = [];
  const reads: string[] = [];
  const base: WebAccess = {
    searchAvailable: true,
    readerEnabled: true,
    renderAvailable: true,
    async search(request) {
      searches.push(request);
      return {
        ok: true,
        query: request.query,
        engines: ["wikipedia", "arxiv"],
        suspended: [{ engine: "duckduckgo", reason: "CAPTCHA" }],
        hits: [
          {
            title: "Hit one",
            url: "https://a.example/1",
            snippet: "About one.",
            engine: "wikipedia",
          },
        ],
      } satisfies WebSearchOutcome;
    },
    async read(request) {
      reads.push(request.url);
      return { ok: true, page: PAGE } satisfies WebReadOutcome;
    },
    extract: async () => undefined,
  };
  return Object.assign({ ...base, ...over }, { searches, reads });
}

async function run(
  name: string,
  args: unknown,
  web?: WebAccess,
  executor?: ToolContext["executor"],
) {
  const ex = executor ?? ((await localWorkspace()) as unknown as ToolContext["executor"]);
  return registry.invoke(name, args, {
    runId: "r",
    botId: "b",
    executor: ex,
    signal: new AbortController().signal,
    now: () => new Date(),
    ...(web === undefined ? {} : { web }),
  });
}

describe("web_search", () => {
  it("asks the service, lists the hits and the engines that did not answer, as external data", async () => {
    const w = web();
    const result = await run(
      "web_search",
      { query: "suup agents", limit: 3, language: "pt", time_range: "year" },
      w,
    );
    expect(result.outcome).toBe("ok");
    expect(w.searches[0]).toMatchObject({
      query: "suup agents",
      limit: 3,
      language: "pt",
      timeRange: "year",
    });
    expect(result.output.content).toContain(EXTERNAL_OPEN);
    expect(result.output.content).toContain("1. Hit one");
    expect(result.output.content).toContain("URL: https://a.example/1");
    expect(result.output.content).toContain("(engine: wikipedia)");
    expect(result.output.content).toContain("duckduckgo (CAPTCHA)");
    expect(result.output.content).toContain("Engines asked: wikipedia, arxiv");
  });

  it("is a read: no approval level above read", () => {
    expect(
      registry.assess("web_search", { query: "x y" }, { executor: { isolated: true } as never })
        ?.level,
    ).toBe("read");
  });

  it("says plainly when there is no search service", async () => {
    const none = await run("web_search", { query: "anything" });
    expect(none.outcome).toBe("tool_error");
    expect(none.output.content).toContain("not available");
    const down = await run(
      "web_search",
      { query: "anything" },
      web({
        search: async () => ({
          ok: false,
          reason: "unavailable",
          message: "Docker is not available.",
        }),
      }),
    );
    expect(down.outcome).toBe("tool_error");
    expect(down.output.content).toContain("Docker is not available.");
  });

  it("an empty result suggests other words", () => {
    const text = formatSearch({
      ok: true,
      query: "q",
      hits: [],
      suspended: [],
      engines: ["wikipedia"],
    }).content;
    expect(text).toContain("No results");
  });

  it("a failed search is an error that says why", () => {
    const out = formatSearch({ ok: false, reason: "failed", message: "Bad answer." });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Bad answer.");
  });

  it("says which engines did not answer and until when, and, with no quota left, that the general search has none, pointing to the other engines", () => {
    const text = formatSearch({
      ok: true,
      query: "q",
      hits: [],
      engines: [],
      suspended: [
        { engine: "tavily", reason: "no credits", retryInSeconds: 3000 },
        { engine: "brave", reason: "no credits", retryInSeconds: 3500 },
      ],
      generalUnavailable: { retryInSeconds: 3000, cause: "quota" },
    }).content;
    expect(text).toContain("tavily (no credits; back in about 50 min)");
    expect(text).toContain("A busca geral está sem cota agora.");
    expect(text).toContain("It should be back in about 50 min.");
    expect(text).toContain("Wikipedia, arXiv, Stack Exchange");
    expect(text).toContain("schedule_return");
    expect(text).toContain("do not retry now");
  });

  it("says why the general search is out: no key set up, Suup's own limit, or no answer", () => {
    const say = (cause: "no_key" | "limit" | "unavailable") =>
      formatSearch({
        ok: true,
        query: "q",
        hits: [],
        engines: [],
        suspended: [],
        generalUnavailable: { cause },
      }).content;
    expect(say("no_key")).toContain("nenhuma chave de busca foi adicionada");
    expect(say("no_key")).not.toContain("sem cota");
    expect(say("limit")).toContain("limite de buscas por minuto");
    expect(say("unavailable")).toContain("A busca geral não respondeu agora.");
  });

  it("says which general engine answered", () => {
    const out = formatSearch({
      ok: true,
      query: "q",
      hits: [{ title: "T", url: "https://a.example/1", snippet: "s", engine: "brave" }],
      engines: ["tavily", "brave"],
      suspended: [{ engine: "tavily", reason: "no credits", retryInSeconds: 3600 }],
      generalEngine: "brave",
    });
    expect(out.content).toContain("General web search answered by: brave.");
    expect(out.content).not.toContain("sem cota");
  });

  it("says when a cached answer was made, and which engines Suup left out for its own limit", () => {
    const out = formatSearch({
      ok: true,
      query: "q",
      hits: [{ title: "T", url: "https://a.example/1", snippet: "", engine: "wikipedia" }],
      engines: ["wikipedia"],
      suspended: [],
      throttled: [{ engine: "duckduckgo", retryInSeconds: 45 }],
      cached: { at: "2026-11-21T10:00:00.000Z", ageSeconds: 7200 },
    });
    expect(out.content).toContain(
      "Cached: these results are from an identical search made at 2026-11-21T10:00:00.000Z (about 120 min ago)",
    );
    expect(out.content).toContain("duckduckgo (free in about 45 s)");
    // A search from the cache still lets the bot read its results without a card.
    expect(out.webUrls).toEqual(["https://a.example/1"]);
  });

  it("a search refused by Suup's own limit says when to try again and not to repeat it now", () => {
    const out = formatSearch({
      ok: false,
      reason: "rate_limited",
      message: "Too many searches in the last minute. Try again in about 40 s.",
      retryInSeconds: 40,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("about 40 s");
    expect(out.content).toContain("Do not repeat the search now");
  });

  it("refuses a query that is too short", async () => {
    expect((await run("web_search", { query: "a" }, web())).outcome).not.toBe("ok");
  });
});

describe("web_read", () => {
  it("reads through the reader service and shows the page with its facts", async () => {
    const w = web();
    const result = await run("web_read", { url: "https://example.com/start" }, w);
    expect(result.outcome).toBe("ok");
    expect(w.reads).toEqual(["https://example.com/start"]);
    expect(result.output.content).toContain(EXTERNAL_OPEN);
    expect(result.output.content).toContain("URL: https://example.com/final");
    expect(result.output.content).toContain("Requested URL: https://example.com/start");
    expect(result.output.content).toContain("Title: A page");
    expect(result.output.content).toContain("Author: Ada");
    expect(result.output.content).toContain("Published: 2026-05-01");
    expect(result.output.content).toContain("by the reader service");
    expect(result.output.content).toContain("Body text.");
  });

  it("passes render to the service", async () => {
    const seen: (boolean | undefined)[] = [];
    const w = web({
      async read(request) {
        seen.push(request.render);
        return { ok: true, page: PAGE };
      },
    });
    await run("web_read", { url: "https://example.com/", render: true }, w);
    await run("web_read", { url: "https://example.com/" }, w);
    expect(seen).toEqual([true, undefined]);
  });

  describe("which addresses need a card", () => {
    const level = (url: string, seen: string[]): string | undefined =>
      registry.assess(
        "web_read",
        { url },
        {
          executor: { isolated: true } as never,
          webSeen: new Map(seen.map((u) => [u, "search_result" as const])),
        },
      )?.level;

    it("an address that already appeared is a read: no card", () => {
      expect(level("https://x.test/a", ["https://x.test/a"])).toBe("read");
    });

    it("an address nobody showed is a card, with the whole URL in the line", () => {
      expect(level("https://x.test/a", [])).toBe("external_irreversible");
      const long = `https://x.test/a?q=${"b".repeat(300)}&token=abc#frag`;
      const assessed = registry.assess(
        "web_read",
        { url: long },
        { executor: { isolated: true } as never },
      );
      expect(assessed?.summary).toBe(`Read a new page: ${long}`);
    });

    it("compares normalized addresses by equality, nothing looser", () => {
      const seen = ["https://example.com/a/b?x=1%2F2"];
      // Same address written differently by the URL standard: scheme and host case, default port, fragment.
      expect(level("HTTPS://Example.COM:443/a/b?x=1%2F2#part", seen)).toBe("read");
      // Different addresses: a trailing slash, another query, percent-encoding written another way, another host.
      expect(level("https://example.com/a/b/?x=1%2F2", seen)).toBe("external_irreversible");
      expect(level("https://example.com/a/b?x=1/2", seen)).toBe("external_irreversible");
      expect(level("https://example.com/a/b?x=1%2f2", seen)).toBe("external_irreversible");
      expect(level("https://example.com/a/b?x=1%2F2&y=2", seen)).toBe("external_irreversible");
      expect(level("https://www.example.com/a/b?x=1%2F2", seen)).toBe("external_irreversible");
      expect(level("http://example.com/a/b?x=1%2F2", seen)).toBe("external_irreversible");
      expect(level("https://example.com:8443/a/b?x=1%2F2", seen)).toBe("external_irreversible");
      expect(level("not a url", seen)).toBe("external_irreversible");
    });

    it("an address with no history at all (a run without the list) is a card", () => {
      expect(
        registry.assess(
          "web_read",
          { url: "https://x.test" },
          { executor: { isolated: true } as never },
        )?.level,
      ).toBe("external_irreversible");
    });
  });

  it("explains a refusal and what to do next", () => {
    const robots = formatRead(
      { ok: false, reason: "robots", message: "robots.txt says no." },
      "reader",
    );
    expect(robots.isError).toBe(true);
    expect(robots.content).toContain("robots.txt says no.");
    expect(robots.content).toContain("another source");
    // could not reach the site: said as a connection problem here, the diagnostic never shown
    const unreachable = formatRead(
      {
        ok: false,
        reason: "unreachable",
        message: "Could not reach pt.wikipedia.org from here right now.",
        diagnostic: { stage: "dns", host: "pt.wikipedia.org", code: "EAI_AGAIN" },
      },
      "reader",
    );
    expect(unreachable.content).toContain("could not reach the site right now");
    expect(unreachable.content).toContain("not the site refusing");
    expect(unreachable.content).not.toContain("Do not look for a way around it");
    expect(unreachable.content).not.toContain("EAI_AGAIN");
    expect(
      formatRead({ ok: false, reason: "private", message: "Private." }, "reader").content,
    ).toContain("public pages only");
  });

  it("notes a cut", () => {
    const out = formatRead(
      {
        ok: true,
        page: { ...PAGE, truncated: true, fullLength: 90_000, markdown: "x".repeat(60_000) },
      },
      "reader",
    );
    expect(out.content).toContain("[Content cut: showing the first 60000 of 90000 characters.]");
  });

  it("declares the page it read as the source of the result (url after redirects, title)", () => {
    const out = formatRead({ ok: true, page: PAGE }, "reader");
    expect(out.source).toEqual({ url: "https://example.com/final", title: "A page" });
    const { title: _title, ...untitled } = PAGE;
    expect(formatRead({ ok: true, page: untitled }, "reader").source).toEqual({
      url: "https://example.com/final",
    });
    expect(formatRead({ ok: false, reason: "robots", message: "no" }, "reader").source).toBe(
      undefined,
    );
  });

  it("with the reader service off, reads with the bot machine (curl through its allowlist) and converts the page", async () => {
    const commands: string[] = [];
    const executor = {
      isolated: true,
      async exec(command: string) {
        commands.push(command);
        return {
          exitCode: 0,
          timedOut: false,
          stderr: "",
          stdout:
            "0\t200\thttps://example.com/p\t0\ttext/html; charset=utf-8\n<html><body><h1>Hi</h1><p>text</p></body></html>",
        };
      },
    } as unknown as ToolContext["executor"];
    const w = web({
      readerEnabled: false,
      extract: async ({ url }) => ({ ...PAGE, url, requestedUrl: url, markdown: "CONVERTED" }),
    });
    const result = await run("web_read", { url: "https://example.com/p" }, w, executor);
    expect(result.outcome).toBe("ok");
    expect(commands[0]).toContain("curl");
    expect(w.reads).toEqual([]);
    expect(result.output.content).toContain("by the bot machine");
    expect(result.output.content).toContain("CONVERTED");
  });

  it("with the reader service off, render is refused and says why", async () => {
    const w = web({ readerEnabled: false });
    const result = await run("web_read", { url: "https://example.com/", render: true }, w);
    expect(result.outcome).toBe("tool_error");
    expect(result.output.content).toContain("turned off");
  });

  it("without any web wiring it still reads with the bot machine, converting the HTML itself", async () => {
    const executor = {
      isolated: true,
      async exec() {
        return {
          exitCode: 0,
          timedOut: false,
          stderr: "",
          stdout:
            "0\t200\thttps://example.com/p\t0\ttext/html\n<html><head><title>T</title></head><body><p>plain words</p></body></html>",
        };
      },
    } as unknown as ToolContext["executor"];
    const result = await run("web_read", { url: "https://example.com/p" }, undefined, executor);
    expect(result.outcome).toBe("ok");
    expect(result.output.content).toContain("plain words");
  });
});
