import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebWiring } from "../src/web/wiring.js";

// A stub that speaks SearXNG's JSON API: what a SearXNG the user runs themselves answers.
let stub: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (stub === undefined ? done() : stub.close(() => done())));
  stub = undefined;
});

async function stubSearx(): Promise<{ url: string; queries: string[] }> {
  const queries: string[] = [];
  stub = createServer((req, res) => {
    queries.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        results: [
          {
            url: "https://en.wikipedia.org/wiki/Test",
            title: "Test",
            content: "A test.",
            engine: "wikipedia",
          },
        ],
        unresponsive_engines: [["arxiv", "timeout"]],
      }),
    );
  });
  await new Promise<void>((done) => stub?.listen(0, "127.0.0.1", done));
  const address = stub.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
    queries,
  };
}

describe("web wiring", () => {
  it("starts nothing until a tool asks, and the doctor does not start it", async () => {
    const wiring = createWebWiring({
      search: { url: "http://127.0.0.1:1" },
      reader: { enabled: false },
    });
    expect(await wiring.status()).toMatchObject({
      started: false,
      search: "pending",
      reader: "off",
    });
    expect(wiring.access.readerEnabled).toBe(false);
    await wiring.close();
  });

  it("searches through the SearXNG it is pointed at", async () => {
    const searx = await stubSearx();
    // Only an engine SearXNG asks: the engines Suup asks itself would go to the internet.
    const wiring = createWebWiring({
      search: { url: searx.url, engines: ["duckduckgo"] },
      reader: { enabled: false },
    });
    const out = await wiring.access.search({ query: "test", limit: 3 });
    expect(out).toMatchObject({
      ok: true,
      hits: [{ title: "Test", url: "https://en.wikipedia.org/wiki/Test", engine: "wikipedia" }],
      suspended: [{ engine: "arxiv", reason: "timeout" }],
    });
    expect(searx.queries[0]).toContain("format=json");
    expect(await wiring.status()).toMatchObject({ started: true, search: "ready", reader: "off" });
    await wiring.close();
  });

  it("says search is off when the configuration turns it off, and reading is off when the reader is", async () => {
    const wiring = createWebWiring({ search: { enabled: false }, reader: { enabled: false } });
    expect(await wiring.access.search({ query: "x y" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await wiring.access.read({ url: "https://example.com/" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await wiring.close();
  });

  it("reads an HTML page already downloaded, with no network", async () => {
    const wiring = createWebWiring({ search: { enabled: false }, reader: { enabled: false } });
    const page = await wiring.access.extract({
      html: "<html><body><p>Just a short note.</p></body></html>",
      url: "https://example.com/n",
    });
    expect(page?.markdown).toBe("Just a short note.");
    await wiring.close();
  });
});
