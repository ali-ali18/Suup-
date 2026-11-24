import { connect, type Socket } from "node:net";
import type { Resolver } from "@suup/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createReader } from "../src/reader.js";
import { RobotsCache } from "../src/robots.js";
import { safeGet } from "../src/safe-fetch.js";
import { createWebAccess, readFailureLogLine } from "../src/service.js";
import { ARTICLE_HTML, localSite, PUBLIC_IP, tableResolver } from "./helpers.js";

// A site we could not REACH (no DNS answer here, no route, a TLS failure) is a problem on this side,
// never the site forbidding robots: the owner's case was "pt.wikipedia.org could not be asked for its
// robots.txt", told to the bot as if the site had closed itself. The logs get what failed.

const UA = "SuupBot/0.1 (+https://example.org/suup)";
const PUBLIC_V6 = "2606:4700:4700::1111";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A port on this machine where nothing listens: connecting there is a real `ECONNREFUSED`. */
async function closedPort(): Promise<number> {
  const s = await localSite((_req, res) => res.end());
  await s.close();
  return s.port;
}

/** A connection that never reaches a server (the system refuses it), as an address with no route does. */
const refused = (port: number): Socket => connect({ host: "127.0.0.1", port });

/** A resolver whose lookup fails on this side (no DNS server answering): `EAI_AGAIN`. */
const brokenDns: Resolver = {
  async resolve() {
    throw Object.assign(new Error("getaddrinfo EAI_AGAIN pt.wikipedia.org"), { code: "EAI_AGAIN" });
  },
};

async function site() {
  const s = await localSite((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(ARTICLE_HTML);
  });
  closers.push(s.close);
  return s;
}

describe("a site that cannot be reached from here", () => {
  it("robots.txt: a DNS failure on this side is `unreachable`, not the site refusing, and asked again soon", async () => {
    let clock = 1_000;
    let calls = 0;
    const resolver: Resolver = {
      async resolve(host) {
        calls += 1;
        return brokenDns.resolve(host);
      },
    };
    const cache = new RobotsCache({ userAgent: UA, resolver, timeoutMs: 500 }, () => clock);
    const verdict = await cache.check(new URL("https://pt.wikipedia.org/wiki/Biblioteca"));
    expect(verdict).toMatchObject({
      allowed: false,
      kind: "unreachable",
      diagnostic: { stage: "dns", host: "pt.wikipedia.org", code: "EAI_AGAIN" },
    });
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("Could not reach pt.wikipedia.org from here right now");
    expect(verdict.reason).toContain("(a DNS problem on this side, not the site)");
    expect(verdict.reason).toContain("The site did not refuse anything");
    expect(verdict.reason).not.toContain("could not be asked for its robots.txt");
    // the spelling of the domain is not what is wrong
    expect(verdict.reason).not.toContain("check the spelling");
    // cached for a short while only
    clock += 30_000;
    await cache.check(new URL("https://pt.wikipedia.org/wiki/Biblioteca"));
    expect(calls).toBe(1);
    clock += 31_000;
    await cache.check(new URL("https://pt.wikipedia.org/wiki/Biblioteca"));
    expect(calls).toBe(2);
  });

  it("robots.txt: a server error is the site's (HTTP status), and closes it for a while", async () => {
    const s = await localSite((_req, res) => res.writeHead(503).end());
    closers.push(s.close);
    const cache = new RobotsCache({
      userAgent: UA,
      resolver: tableResolver({ "site.example.com": [PUBLIC_IP] }),
      dial: s.dial,
    });
    expect(await cache.check(new URL("http://site.example.com/a"))).toMatchObject({
      allowed: false,
      kind: "server_error",
      status: 503,
    });
  });

  it("the reader says `unreachable` (with the diagnostic for the logs) when the robots.txt cannot be fetched", async () => {
    const reader = createReader({ resolver: brokenDns, minIntervalMs: 0, timeoutMs: 500 });
    const out = await reader.read({ url: "https://pt.wikipedia.org/wiki/Biblioteca" });
    expect(out).toMatchObject({
      ok: false,
      reason: "unreachable",
      diagnostic: { request: "robots", stage: "dns", code: "EAI_AGAIN" },
    });
  });

  it("a name with no route on its first address is read through the next one (every one was checked)", async () => {
    const s = await site();
    const dead = await closedPort();
    const dialed: string[] = [];
    const out = await safeGet("http://dual.example.com/post", {
      userAgent: UA,
      resolver: tableResolver({ "dual.example.com": [PUBLIC_V6, PUBLIC_IP] }),
      dial: (address, port) => {
        dialed.push(address);
        return address === PUBLIC_V6 ? refused(dead) : s.dial(address, port);
      },
    });
    expect(out.ok).toBe(true);
    expect(dialed).toEqual([PUBLIC_V6, PUBLIC_IP]);
  });

  it("when no address connects, the page is `unreachable`, and the log line says the step, code and addresses", async () => {
    const dead = await closedPort();
    const reader = createReader({
      resolver: tableResolver({ "down.example.com": [PUBLIC_V6, PUBLIC_IP] }),
      dial: () => refused(dead),
      robots: false,
      minIntervalMs: 0,
      timeoutMs: 500,
    });
    const out = await reader.read({ url: "http://down.example.com/post" });
    expect(out).toMatchObject({
      ok: false,
      reason: "unreachable",
      diagnostic: {
        request: "page",
        stage: "connect",
        code: "ECONNREFUSED",
        addresses: [PUBLIC_V6, PUBLIC_IP],
      },
    });
    expect(readFailureLogLine(out, "container")).toBe(
      `web_read: could not reach down.example.com (page, reader container, reason unreachable): stage=connect code=ECONNREFUSED addresses=${PUBLIC_V6},${PUBLIC_IP} detail="connect ECONNREFUSED 127.0.0.1:${dead}"`,
    );
  });

  it("the web access writes that line to the log, and only for a read that could not reach the site", async () => {
    const lines: string[] = [];
    const web = createWebAccess({
      searchEnabled: false,
      readerEnabled: true,
      services: async () => ({ engines: [] }),
      local: createReader({ resolver: brokenDns, minIntervalMs: 0, timeoutMs: 500 }),
      log: (line) => lines.push(line),
    });
    const out = await web.read({ url: "https://pt.wikipedia.org/wiki/Biblioteca" });
    expect(out.ok).toBe(false);
    expect(lines).toEqual([
      "web_read: could not reach pt.wikipedia.org (robots, reader local, reason unreachable): stage=dns code=EAI_AGAIN",
    ]);
    // an address that is refused on purpose is not a network failure: nothing in the log
    await web.read({ url: "http://localhost/" });
    expect(lines).toHaveLength(1);
  });
});
