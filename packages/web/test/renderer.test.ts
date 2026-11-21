import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReader } from "../src/reader.js";
import { createPlaywrightRenderer } from "../src/renderer.js";
import { localSite, PUBLIC_IP, tableResolver } from "./helpers.js";

// The real renderer: a headless Chromium behind the proxy that only takes public host NAMES. The
// fixture site is local, so the name is mapped to a "public" address by the resolver and the proxy's
// connection is sent to the local server (the same seams the proxy's own tests use).
//
// The browser is the one the environment provides: SUUP_CHROMIUM_PATH, else the one Playwright
// installed for this version, else any Chromium under PLAYWRIGHT_BROWSERS_PATH. CI installs it
// (`playwright install chromium`) and so does the reader image. Without a browser the file is
// skipped, and says so: the real check of the renderer then happens in CI.
function chromiumPath(): string | undefined {
  const explicit = process.env.SUUP_CHROMIUM_PATH;
  if (explicit !== undefined && explicit !== "") return explicit;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base === undefined || !existsSync(base)) return undefined;
  for (const name of readdirSync(base)) {
    if (!name.startsWith("chromium-")) continue;
    const candidate = join(base, name, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const JS_ONLY = `<!doctype html><html><head><title>App shell</title></head><body>
<div id="app">Loading...</div>
<script>
  setTimeout(function () {
    var root = document.getElementById("app");
    root.innerHTML = "<h1>Rendered by JavaScript</h1><p>" + "This sentence only exists after the script runs, and it is long enough to be the main text of the page for the extractor. ".repeat(3) + "</p>";
    fetch("http://127.0.0.1:1/leak").catch(function () {});
  }, 50);
</script></body></html>`;

const CHROMIUM = chromiumPath();
let site: Awaited<ReturnType<typeof localSite>>;
let renderer: Awaited<ReturnType<typeof createPlaywrightRenderer>>;

beforeAll(async () => {
  if (CHROMIUM === undefined) return;
  site = await localSite((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(404).end();
    if (req.url === "/app") return res.writeHead(200, { "content-type": "text/html" }).end(JS_ONLY);
    if (req.url === "/img.png")
      return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1]));
    return res.writeHead(404).end();
  });
  renderer = await createPlaywrightRenderer({
    userAgent: "SuupBot/0.1 (+https://example.org/suup)",
    resolver: tableResolver({ "app.example.com": [PUBLIC_IP], "inside.example.com": ["10.0.0.5"] }),
    dial: () => site.dial("", 0),
    noSandbox: true,
    timeoutMs: 15_000,
    ...(CHROMIUM === undefined ? {} : { executablePath: CHROMIUM }),
  });
}, 60_000);
afterAll(async () => {
  await renderer?.close();
  await site?.close();
});

describe.skipIf(CHROMIUM === undefined)("the renderer", () => {
  it("reads a page that is empty without JavaScript", async () => {
    const reader = createReader({
      resolver: tableResolver({ "app.example.com": [PUBLIC_IP] }),
      dial: site.dial,
      minIntervalMs: 0,
      renderer,
    });
    const plain = await reader.read({ url: "http://app.example.com/app" });
    expect(plain.ok && plain.page.markdown).not.toContain("Rendered by JavaScript");
    const rendered = await reader.read({ url: "http://app.example.com/app", render: true });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.page.markdown).toContain("Rendered by JavaScript");
    expect(rendered.page.markdown).toContain("only exists after the script runs");
    expect(rendered.page.rendered).toBe(true);
  }, 30_000);

  it("does not let the page reach a private address (the script's fetch to loopback goes nowhere)", async () => {
    const before = site.requests.length;
    await renderer.render("http://app.example.com/app");
    // Only the page itself (and nothing aimed at 127.0.0.1:1) reached the fixture server.
    expect(site.requests.slice(before).every((r) => r.url === "/app")).toBe(true);
  }, 30_000);

  it("refuses a name that resolves to a private address, and an address (the proxy answers 403)", async () => {
    for (const url of [
      "http://inside.example.com/",
      "http://127.0.0.1:80/",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const out = await renderer.render(url).catch(() => ({ status: 0, html: "refused" }));
      expect(out.status === 403 || out.status === 0, url).toBe(true);
      expect(out.html, url).not.toContain("ami-id");
    }
  }, 30_000);

  it("keeps no cookies between pages", async () => {
    const jar = await localSite((req, res) => {
      if (req.url === "/set")
        return res
          .writeHead(200, { "content-type": "text/html", "set-cookie": "k=v; Path=/" })
          .end("<html><body><p>set</p></body></html>");
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<html><body><p id="c"></p><script>document.getElementById("c").textContent = "cookie:[" + document.cookie + "]"</script></body></html>`,
        );
    });
    const own = await createPlaywrightRenderer({
      userAgent: "SuupBot/0.1",
      resolver: tableResolver({ "jar.example.com": [PUBLIC_IP] }),
      dial: () => jar.dial("", 0),
      noSandbox: true,
      ...(CHROMIUM === undefined ? {} : { executablePath: CHROMIUM }),
    });
    try {
      await own.render("http://jar.example.com/set");
      const second = await own.render("http://jar.example.com/read");
      expect(second.html).toContain("cookie:[]");
    } finally {
      await own.close();
      await jar.close();
    }
  }, 40_000);
});
