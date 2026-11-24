import { afterEach, describe, expect, it } from "vitest";
import { createReader, kindOf, userAgent } from "../src/reader.js";
import { ARTICLE_HTML, localSite, PUBLIC_IP, tableResolver } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function readerFor(
  routes: Record<string, { status?: number; type?: string; body: string | Buffer }>,
) {
  const s = await localSite((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) return res.writeHead(404).end("missing");
    res
      .writeHead(
        route.status ?? 200,
        route.type === undefined ? {} : { "content-type": route.type },
      )
      .end(route.body);
  });
  closers.push(s.close);
  const resolver = tableResolver({
    "site.example.com": [PUBLIC_IP],
    "inside.example.com": ["10.0.0.9"],
  });
  const reader = createReader({ resolver, dial: s.dial, minIntervalMs: 0, timeoutMs: 2000 });
  return { reader, s, resolver };
}

describe("userAgent", () => {
  it("names the product, its version and where to read about it", () => {
    expect(userAgent("0.1", "https://example.org/suup")).toBe(
      "SuupBot/0.1 (+https://example.org/suup)",
    );
  });
});

describe("web reader", () => {
  it("reads a page into Markdown with its final URL", async () => {
    const { reader } = await readerFor({
      "/robots.txt": { status: 404, body: "" },
      "/post": { type: "text/html; charset=utf-8", body: ARTICLE_HTML },
    });
    const out = await reader.read({ url: "http://site.example.com/post" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.page.url).toBe("http://site.example.com/post");
    expect(out.page.status).toBe(200);
    expect(out.page.markdown).toContain("## Details");
    expect(out.page.byline).toBe("By Ada Lovelace");
  });

  it("does not read a page the robots.txt closes, and never asks for the page", async () => {
    const { reader, s } = await readerFor({
      "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /post\n" },
      "/post": { type: "text/html", body: ARTICLE_HTML },
    });
    const out = await reader.read({ url: "http://site.example.com/post" });
    expect(out).toMatchObject({ ok: false, reason: "robots" });
    expect(s.requests.map((r) => r.url)).toEqual(["/robots.txt"]);
  });

  it("refuses private names and addresses without any request", async () => {
    const { reader, s } = await readerFor({});
    expect(await reader.read({ url: "http://inside.example.com/" })).toMatchObject({
      ok: false,
      reason: "private",
    });
    expect(await reader.read({ url: "http://127.0.0.1/" })).toMatchObject({
      ok: false,
      reason: "private",
    });
    expect(await reader.read({ url: "http://169.254.169.254/latest" })).toMatchObject({
      ok: false,
      reason: "private",
    });
    expect(await reader.read({ url: "not a url" })).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
    expect(s.requests).toEqual([]);
  });

  it("returns plain text and JSON as they are", async () => {
    const { reader } = await readerFor({
      "/robots.txt": { status: 404, body: "" },
      "/data.json": { type: "application/json", body: '{"a":1}' },
    });
    const out = await reader.read({ url: "http://site.example.com/data.json" });
    expect(out.ok && out.page.markdown).toBe('{"a":1}');
    expect(out.ok && out.page.extraction).toBe("plain");
  });

  it("does not read a file that is not text", async () => {
    const { reader } = await readerFor({
      "/robots.txt": { status: 404, body: "" },
      "/a.pdf": { type: "application/pdf", body: Buffer.from("%PDF-1.7 binary") },
      "/b.bin": { body: Buffer.from([1, 2, 0, 3]) },
    });
    expect(await reader.read({ url: "http://site.example.com/a.pdf" })).toMatchObject({
      ok: false,
      reason: "not_text",
    });
    expect(await reader.read({ url: "http://site.example.com/b.bin" })).toMatchObject({
      ok: false,
      reason: "not_text",
    });
  });

  it("reports an HTTP error with its status", async () => {
    const { reader } = await readerFor({ "/robots.txt": { status: 404, body: "" } });
    expect(await reader.read({ url: "http://site.example.com/missing" })).toMatchObject({
      ok: false,
      reason: "http",
      status: 404,
    });
  });

  it("cuts the text at the limit", async () => {
    const s = await localSite((req, res) =>
      req.url === "/robots.txt"
        ? res.writeHead(404).end()
        : res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(5000)),
    );
    closers.push(s.close);
    const reader = createReader({
      resolver: tableResolver({ "site.example.com": [PUBLIC_IP] }),
      dial: s.dial,
      minIntervalMs: 0,
      maxChars: 1000,
    });
    const out = await reader.read({ url: "http://site.example.com/long" });
    expect(out.ok && out.page.markdown.length).toBe(1000);
    expect(out.ok && out.page.truncated).toBe(true);
    expect(out.ok && out.page.fullLength).toBe(5000);
  });

  it("says rendering is not available when there is no renderer", async () => {
    const { reader } = await readerFor({});
    expect(reader.renderAvailable).toBe(false);
    expect(await reader.read({ url: "http://site.example.com/", render: true })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("with a renderer, reads what the browser produced", async () => {
    const reader = createReader({
      resolver: tableResolver({ "site.example.com": [PUBLIC_IP] }),
      minIntervalMs: 0,
      robots: false,
      renderer: {
        async render(url) {
          return {
            html: ARTICLE_HTML.replace("first paragraph", "RENDERED paragraph"),
            url,
            status: 200,
          };
        },
      },
    });
    const out = await reader.read({ url: "http://site.example.com/app", render: true });
    expect(out.ok && out.page.markdown).toContain("RENDERED paragraph");
    expect(out.ok && out.page.rendered).toBe(true);
  });

  it("extracts HTML the bot's machine already downloaded", async () => {
    const { reader } = await readerFor({});
    const page = reader.extract({ html: ARTICLE_HTML, url: "https://example.com/x" });
    expect(page?.markdown).toContain("The first paragraph");
  });
});

describe("kindOf", () => {
  it("decides by the declared type, by equality", () => {
    const b = Buffer.from("x");
    expect(kindOf("text/html; charset=utf-8", b)).toBe("html");
    expect(kindOf("application/xhtml+xml", b)).toBe("html");
    expect(kindOf("text/markdown", b)).toBe("text");
    expect(kindOf("application/ld+json", b)).toBe("text");
    expect(kindOf("image/png", b)).toBe("binary");
    expect(kindOf("", b)).toBe("text");
    expect(kindOf("text/plain", Buffer.from([0]))).toBe("binary");
  });
});
