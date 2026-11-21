import { afterEach, describe, expect, it } from "vitest";
import { RobotsCache } from "../src/robots.js";
import { localSite, PUBLIC_IP, tableResolver } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const UA = "SuupBot/0.1 (+https://example.org/suup)";

async function cacheFor(robots: { status: number; body?: string } | "hang", now?: () => number) {
  const s = await localSite((req, res) => {
    if (req.url !== "/robots.txt") return res.writeHead(404).end();
    if (robots === "hang") return;
    res.writeHead(robots.status, { "content-type": "text/plain" }).end(robots.body ?? "");
  });
  closers.push(s.close);
  const resolver = tableResolver({ "site.example.com": [PUBLIC_IP] });
  return {
    s,
    cache: new RobotsCache({ userAgent: UA, resolver, dial: s.dial, timeoutMs: 200 }, now),
  };
}

const url = (path: string) => new URL(`http://site.example.com${path}`);

describe("RobotsCache", () => {
  it("applies the rules of the file for our product token (library semantics)", async () => {
    const { cache } = await cacheFor({
      status: 200,
      body: [
        "User-agent: *",
        "Disallow: /private/",
        "Allow: /private/open",
        "",
        "User-agent: SuupBot",
        "Disallow: /no-suup/",
        "Crawl-delay: 2",
      ].join("\n"),
    });
    // The SuupBot group replaces the * group for us.
    expect((await cache.check(url("/no-suup/page"))).allowed).toBe(false);
    expect((await cache.check(url("/private/page"))).allowed).toBe(true);
    expect((await cache.check(url("/anything"))).allowed).toBe(true);
  });

  it("applies the * group when there is none for us, with the longest rule winning", async () => {
    const { cache } = await cacheFor({
      status: 200,
      body: "User-agent: *\nDisallow: /private/\nAllow: /private/open\n",
    });
    expect((await cache.check(url("/private/page"))).allowed).toBe(false);
    expect((await cache.check(url("/private/open"))).allowed).toBe(true);
    expect((await cache.check(url("/public"))).allowed).toBe(true);
  });

  it("a site that closes everything to robots is not read", async () => {
    const { cache } = await cacheFor({ status: 200, body: "User-agent: *\nDisallow: /\n" });
    const verdict = await cache.check(url("/page"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("robots.txt");
  });

  it("no robots.txt (404) allows everything", async () => {
    const { cache } = await cacheFor({ status: 404 });
    expect((await cache.check(url("/page"))).allowed).toBe(true);
  });

  it("a server error closes the site for a while", async () => {
    const { cache } = await cacheFor({ status: 503 });
    expect((await cache.check(url("/page"))).allowed).toBe(false);
  });

  it("no answer closes the site for a while", async () => {
    const { cache } = await cacheFor("hang");
    expect((await cache.check(url("/page"))).allowed).toBe(false);
  });

  it("asks once per host while the answer is fresh, and again after it expires", async () => {
    let clock = 1_000;
    const { s, cache } = await cacheFor(
      { status: 200, body: "User-agent: *\nAllow: /\n" },
      () => clock,
    );
    await cache.check(url("/a"));
    await cache.check(url("/b"));
    expect(s.requests.filter((r) => r.url === "/robots.txt")).toHaveLength(1);
    clock += 2 * 60 * 60 * 1000;
    await cache.check(url("/c"));
    expect(s.requests.filter((r) => r.url === "/robots.txt")).toHaveLength(2);
  });
});
