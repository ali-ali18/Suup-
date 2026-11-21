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

  it("is a read: no card", () => {
    expect(
      registry.assess(
        "web_read",
        { url: "https://x.test" },
        { executor: { isolated: true } as never },
      )?.level,
    ).toBe("read");
  });

  it("explains a refusal and what to do next", () => {
    const robots = formatRead(
      { ok: false, reason: "robots", message: "robots.txt says no." },
      "reader",
    );
    expect(robots.isError).toBe(true);
    expect(robots.content).toContain("robots.txt says no.");
    expect(robots.content).toContain("another source");
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
