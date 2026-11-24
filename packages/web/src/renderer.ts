// Owns running a page in a headless Chromium (Playwright) for pages that build their content with
// JavaScript. It only runs inside the renderer container (docker/reader), never in the bot machine.
//
// What keeps it from being a way into the private network: the browser has NO network of its own.
// Every request it makes goes through a local proxy (the egress proxy in `openWeb` mode) that
// accepts only public host NAMES, resolves each name once, refuses private, loopback, link-local and
// metadata addresses, and connects to the address it validated. Loopback is not exempt from the
// proxy (`<-loopback>`). A new browser context per page: no profile on disk, no cookies, no storage,
// no service workers, no downloads, no WebSockets. Images, media and fonts are not downloaded.

import type { Resolver } from "@suup/sandbox";
import { EgressProxy } from "@suup/sandbox";
import type { PageRenderer } from "./reader.js";

export interface PlaywrightRendererOptions {
  userAgent: string;
  resolver?: Resolver;
  /** Path of the Chromium executable; default: the one Playwright installed. */
  executablePath?: string;
  /** Whole time for one page, in ms. Default 30000. */
  timeoutMs?: number;
  /** Cut on the rendered HTML. Default 5 MB. */
  maxHtmlBytes?: number;
  /** Test seam: where the proxy's validated connection really goes (a local fixture server). */
  dial?: ConstructorParameters<typeof EgressProxy>[0]["dial"];
  /** Chromium needs `--no-sandbox` when it runs as a user without the kernel features (a container). */
  noSandbox?: boolean;
}

const BLOCKED_TYPES = new Set(["image", "media", "font"]);

export async function createPlaywrightRenderer(
  options: PlaywrightRendererOptions,
): Promise<PageRenderer & { close(): Promise<void> }> {
  const { chromium } = await import("playwright-core");
  const proxy = new EgressProxy({
    policy: { allowedHosts: async () => new Set() },
    openWeb: true,
    listenHost: "127.0.0.1",
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.dial === undefined ? {} : { dial: options.dial }),
  });
  const address = await proxy.start();
  const subject = { kind: "harness", id: "renderer" } as const;
  const credentials = new URL(proxy.proxyUrlFor(subject));
  const browser = await chromium.launch({
    headless: true,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    args: [
      ...(options.noSandbox === true ? ["--no-sandbox"] : []),
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-pings",
      "--dns-prefetch-disable",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
    proxy: {
      server: `http://${address.host}:${address.port}`,
      username: decodeURIComponent(credentials.username),
      password: decodeURIComponent(credentials.password),
      bypass: "<-loopback>",
    },
  });
  const limit = options.timeoutMs ?? 30_000;
  const maxHtml = options.maxHtmlBytes ?? 5_000_000;

  return {
    async render(url, signal) {
      const context = await browser.newContext({
        userAgent: options.userAgent,
        acceptDownloads: false,
        serviceWorkers: "block",
        javaScriptEnabled: true,
        bypassCSP: false,
        permissions: [],
      });
      const timer = setTimeout(() => void context.close().catch(() => undefined), limit + 5_000);
      const onAbort = () => void context.close().catch(() => undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await context.routeWebSocket(
          () => true,
          (socket) => void socket.close(),
        );
        const page = await context.newPage();
        await page.route(
          () => true,
          (route) =>
            BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue(),
        );
        const response = await page.goto(url, { timeout: limit, waitUntil: "load" });
        // Give scripts that fill the page after load a short moment, but never wait for the network to go quiet forever.
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        const html = await page.content();
        return {
          html: html.length > maxHtml ? html.slice(0, maxHtml) : html,
          url: page.url(),
          status: response?.status() ?? 0,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        await context.close().catch(() => undefined);
      }
    },
    async close() {
      await browser.close().catch(() => undefined);
      await proxy.stop();
    },
  };
}
