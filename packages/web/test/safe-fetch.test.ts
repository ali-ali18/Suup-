import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { checkWebUrl, parseWebUrl, safeGet } from "../src/safe-fetch.js";
import { localSite, PUBLIC_IP, tableResolver } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function site(handler: Parameters<typeof localSite>[0]) {
  const s = await localSite(handler);
  closers.push(s.close);
  return s;
}

const UA = "SuupBot/0.1 (+https://example.org/suup)";

describe("checkWebUrl", () => {
  const check = (text: string) => checkWebUrl(parseWebUrl(text) as URL);
  it("refuses what is not a public host name over http(s) on 80 or 443", () => {
    expect(check("ftp://example.com/x")?.reason).toBe("invalid_url");
    expect(check("https://user:pw@example.com/")?.reason).toBe("invalid_url");
    expect(check("https://example.com:8443/")?.reason).toBe("invalid_url");
    expect(check("http://127.0.0.1/")?.reason).toBe("private");
    expect(check("http://169.254.169.254/latest/meta-data")?.reason).toBe("private");
    expect(check("http://[::1]/")?.reason).toBe("private");
    expect(check("http://2130706433/")?.reason).toBe("private");
    expect(check("http://localhost/")?.reason).toBe("private");
    expect(check("http://intranet/")?.reason).toBe("private");
    expect(check("https://example.com/ok")).toBeUndefined();
    expect(check("http://example.com:80/ok")).toBeUndefined();
  });
});

describe("safeGet", () => {
  it("refuses a name that resolves to a private address, after the DNS answer", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.9",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      const resolver = tableResolver({ "evil.example.com": [address] });
      const result = await safeGet("https://evil.example.com/", { userAgent: UA, resolver });
      expect(result, address).toMatchObject({ ok: false, reason: "private" });
    }
  });

  it("refuses a name when ANY of its answers is private (rebinding)", async () => {
    const resolver = tableResolver({ "mix.example.com": [PUBLIC_IP, "10.1.2.3"] });
    expect(await safeGet("http://mix.example.com/", { userAgent: UA, resolver })).toMatchObject({
      ok: false,
      reason: "private",
    });
  });

  it("says so when the name does not resolve", async () => {
    const result = await safeGet("http://nope.example.com/", {
      userAgent: UA,
      resolver: tableResolver({}),
    });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
  });

  it("checks every redirect again: a public page that redirects to a private name is refused", async () => {
    const s = await site((_req, res) => {
      res.writeHead(302, { location: "http://internal.example.com/secret" }).end();
    });
    const resolver = tableResolver({
      "public.example.com": [PUBLIC_IP],
      "internal.example.com": ["10.0.0.7"],
    });
    const result = await safeGet("http://public.example.com/", {
      userAgent: UA,
      resolver,
      dial: s.dial,
    });
    expect(result).toMatchObject({ ok: false, reason: "private" });
    expect(resolver.calls).toEqual(["public.example.com", "internal.example.com"]);
  });

  it("refuses a redirect to an IP literal and to another scheme", async () => {
    const a = await site((_req, res) =>
      res.writeHead(302, { location: "http://127.0.0.1:80/" }).end(),
    );
    const resolver = tableResolver({ "public.example.com": [PUBLIC_IP] });
    expect(
      await safeGet("http://public.example.com/", { userAgent: UA, resolver, dial: a.dial }),
    ).toMatchObject({ ok: false, reason: "private" });
    const b = await site((_req, res) =>
      res.writeHead(302, { location: "file:///etc/passwd" }).end(),
    );
    expect(
      await safeGet("http://public.example.com/", { userAgent: UA, resolver, dial: b.dial }),
    ).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("follows public redirects up to the limit", async () => {
    const s = await site((req, res) => {
      if (req.url === "/start") res.writeHead(301, { location: "/final" }).end();
      else res.writeHead(200, { "content-type": "text/plain" }).end("done");
    });
    const resolver = tableResolver({ "public.example.com": [PUBLIC_IP] });
    const ok = await safeGet("http://public.example.com/start", {
      userAgent: UA,
      resolver,
      dial: s.dial,
    });
    expect(ok).toMatchObject({
      ok: true,
      url: "http://public.example.com/final",
      redirects: 1,
      status: 200,
    });

    const loop = await site((_req, res) => res.writeHead(302, { location: "/again" }).end());
    const result = await safeGet("http://public.example.com/", {
      userAgent: UA,
      resolver,
      dial: loop.dial,
      maxRedirects: 3,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });

  it("sends an honest user agent and nothing else about the user", async () => {
    const s = await site((_req, res) =>
      res.writeHead(200, { "content-type": "text/plain" }).end("hi"),
    );
    const resolver = tableResolver({ "public.example.com": [PUBLIC_IP] });
    await safeGet("http://public.example.com/x", { userAgent: UA, resolver, dial: s.dial });
    const sent = s.requests[0]?.headers ?? {};
    expect(sent["user-agent"]).toBe(UA);
    expect(sent.host).toBe("public.example.com");
    expect(sent.cookie).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
  });

  it("limits the size, counted after decompression", async () => {
    const big = "a".repeat(200_000);
    const s = await site((_req, res) => {
      res
        .writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
        .end(gzipSync(big));
    });
    const resolver = tableResolver({ "public.example.com": [PUBLIC_IP] });
    const small = await safeGet("http://public.example.com/", {
      userAgent: UA,
      resolver,
      dial: s.dial,
      maxBytes: 50_000,
    });
    expect(small).toMatchObject({ ok: false, reason: "too_large" });
    const fits = await safeGet("http://public.example.com/", {
      userAgent: UA,
      resolver,
      dial: s.dial,
      maxBytes: 300_000,
    });
    expect(fits.ok && fits.body.length).toBe(200_000);
  });

  it("stops at the time limit", async () => {
    const s = await site(() => {
      /* never answers */
    });
    const resolver = tableResolver({ "public.example.com": [PUBLIC_IP] });
    const result = await safeGet("http://public.example.com/", {
      userAgent: UA,
      resolver,
      dial: s.dial,
      timeoutMs: 150,
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});
