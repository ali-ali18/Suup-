// Owns reading ONE public page: the URL is checked, the site's robots.txt and a polite pace are
// respected, the page is downloaded by `safeGet` (public addresses only), and its main content is
// turned into Markdown. With `render`, a headless browser (a separate renderer, see renderer.ts)
// runs the page first. This is the reader service: it is not the bot's machine and does not use the
// bot's allowlist (docs/REDE.md, "A leitura de páginas").
import type { WebPage, WebReadOutcome, WebReadRequest } from "@suup/core";
import type { Resolver } from "@suup/sandbox";
import { extractPage, READ_MAX_CHARS } from "./extract.js";
import { HostLimiter } from "./rate-limit.js";
import { RobotsCache } from "./robots.js";
import { checkWebUrl, parseWebUrl, type SafeFetchOptions, safeGet } from "./safe-fetch.js";

export const WEB_VERSION = "0.1";
export const REPOSITORY_URL = "https://github.com/ali-ali18/suup-";

/** The honest user agent: product, version and where to read about it. */
export function userAgent(
  version: string = WEB_VERSION,
  repository: string = REPOSITORY_URL,
): string {
  return `SuupBot/${version} (+${repository})`;
}

/** What turns a URL into rendered HTML (a browser). The reader asks it only when `render` is true. */
export interface PageRenderer {
  render(url: string, signal?: AbortSignal): Promise<{ html: string; url: string; status: number }>;
}

export interface ReaderOptions {
  userAgent?: string;
  resolver?: Resolver;
  /** Respect robots.txt. Default true; the only reason to turn it off is a test. */
  robots?: boolean;
  /** Minimum time between two requests to one host. Default 1000. */
  minIntervalMs?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxChars?: number;
  renderer?: PageRenderer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dial?: SafeFetchOptions["dial"];
}

export interface Reader {
  readonly renderAvailable: boolean;
  read(request: WebReadRequest): Promise<WebReadOutcome>;
  extract(input: { html: string; url: string }): WebPage | undefined;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/rss+xml",
  "application/atom+xml",
]);

type Kind = "html" | "text" | "binary";

/** By exact comparison of the declared type; no sniffing by pattern. An undeclared type is read as text when it has no NUL. */
export function kindOf(contentType: string, body: Buffer): Kind {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (body.includes(0)) return "binary";
  if (HTML_TYPES.has(type)) return "html";
  if (type === "") return "text";
  if (type.startsWith("text/") || TEXT_TYPES.has(type)) return "text";
  const plus = type.lastIndexOf("+");
  if (plus > 0) {
    const suffix = type.slice(plus + 1);
    if (suffix === "json" || suffix === "xml" || suffix === "yaml") return "text";
  }
  return "binary";
}

export function createReader(options: ReaderOptions = {}): Reader {
  const agent = options.userAgent ?? userAgent();
  const fetchOptions: SafeFetchOptions = {
    userAgent: agent,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.dial === undefined ? {} : { dial: options.dial }),
  };
  const limiter = new HostLimiter({
    minIntervalMs: options.minIntervalMs ?? 1000,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const robots = options.robots === false ? undefined : new RobotsCache(fetchOptions, options.now);
  const maxChars = options.maxChars ?? READ_MAX_CHARS;

  return {
    renderAvailable: options.renderer !== undefined,
    extract(input) {
      const page = extractPage(input.html, input.url, { maxChars });
      return page === undefined ? undefined : { ...page, status: 200, requestedUrl: input.url };
    },
    async read(request): Promise<WebReadOutcome> {
      const url = parseWebUrl(request.url);
      if (url === undefined) {
        return {
          ok: false,
          reason: "invalid_url",
          message: `${JSON.stringify(request.url)} is not a valid absolute URL. Give a full URL such as https://example.com/page.`,
        };
      }
      const refused = checkWebUrl(url);
      if (refused !== undefined) return { ok: false, ...refused };
      if (request.render === true && options.renderer === undefined) {
        return {
          ok: false,
          reason: "unavailable",
          message:
            "Rendering pages with JavaScript is not available here. Read without render, or use another source.",
        };
      }

      if (robots !== undefined) {
        const verdict = await robots.check(url);
        if (!verdict.allowed) return { ok: false, reason: verdict.kind, message: verdict.reason };
      }
      await limiter.wait(url.hostname);

      if (request.render === true && options.renderer !== undefined) {
        try {
          const rendered = await options.renderer.render(url.href, request.signal);
          if (rendered.status >= 400) {
            return {
              ok: false,
              reason: "http",
              status: rendered.status,
              message: `The server answered with HTTP ${rendered.status} for ${rendered.url}, so the page was not retrieved.`,
            };
          }
          const page = extractPage(rendered.html, rendered.url, { maxChars, rendered: true });
          if (page === undefined) {
            return {
              ok: false,
              reason: "failed",
              message: "The page was rendered but has no readable text.",
            };
          }
          return { ok: true, page: { ...page, status: rendered.status, requestedUrl: url.href } };
        } catch (error) {
          return {
            ok: false,
            reason: "failed",
            message: `Rendering ${url.href} failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      const response = await safeGet(url.href, {
        ...fetchOptions,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!response.ok)
        return {
          ok: false,
          reason: response.reason === "too_many_redirects" ? "failed" : response.reason,
          message: response.message,
        };
      if (response.status >= 400) {
        return {
          ok: false,
          reason: "http",
          status: response.status,
          message: `The server answered with HTTP ${response.status} for ${response.url}, so the page was not retrieved.`,
        };
      }
      const kind = kindOf(response.contentType, response.body);
      if (kind === "binary") {
        return {
          ok: false,
          reason: "not_text",
          message: `${response.url} is not a text page (content type ${response.contentType === "" ? "unknown" : JSON.stringify(response.contentType)}), so it was not read.`,
        };
      }
      const text = response.body.toString("utf8");
      if (kind === "text") {
        const trimmed = text.trim();
        const truncated = trimmed.length > maxChars;
        return {
          ok: true,
          page: {
            url: response.url,
            requestedUrl: url.href,
            status: response.status,
            extraction: "plain",
            markdown: truncated ? trimmed.slice(0, maxChars) : trimmed,
            truncated,
            fullLength: trimmed.length,
            rendered: false,
          },
        };
      }
      const page = extractPage(text, response.url, { maxChars });
      if (page === undefined) {
        return {
          ok: false,
          reason: "failed",
          message: `${response.url} has no text in it. If it builds its content with JavaScript, try again with render.`,
        };
      }
      return { ok: true, page: { ...page, status: response.status, requestedUrl: url.href } };
    },
  };
}
