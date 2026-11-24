// Owns "may our robot read this URL": the site's robots.txt, read with `robots-parser` (rule
// semantics are that library's, not ours), cached per host. Our honest user agent names the product
// token `SuupBot`.
//
// What the file's status means (the usual convention for robots.txt): 2xx, the rules apply; 4xx (no
// file, or not allowed to see it), no rules, so everything is allowed; a server error or no answer,
// the site is treated as closed for a while (we do not guess). RFC 9309 itself could not be read
// when this was researched (docs/pesquisas/fase-4-busca-na-web.md), so this follows the library and
// that convention.
import robotsParser from "robots-parser";
import { type SafeFetchOptions, safeGet } from "./safe-fetch.js";

export const ROBOTS_PRODUCT_TOKEN = "SuupBot";
export const ROBOTS_MAX_BYTES = 512_000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_CACHE_MAX = 2000;

export type RobotsVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; kind: "robots" | "private" };

interface Entry {
  until: number;
  /** `undefined`: the site could not be asked, so it is closed until `until`. */
  rules: ReturnType<typeof robotsParser> | "all" | "none" | "private";
}

export class RobotsCache {
  readonly #fetchOptions: SafeFetchOptions;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Entry>>();

  constructor(fetchOptions: SafeFetchOptions, now: () => number = Date.now) {
    this.#fetchOptions = fetchOptions;
    this.#now = now;
  }

  async check(url: URL): Promise<RobotsVerdict> {
    const origin = url.origin;
    let entry = this.#entries.get(origin);
    if (entry === undefined || entry.until <= this.#now()) {
      let pending = this.#pending.get(origin);
      if (pending === undefined) {
        pending = this.#load(origin).finally(() => this.#pending.delete(origin));
        this.#pending.set(origin, pending);
      }
      entry = await pending;
    }
    if (entry.rules === "all") return { allowed: true };
    if (entry.rules === "private") {
      return {
        allowed: false,
        kind: "private",
        reason: `${url.hostname} points to a private, loopback, link-local or metadata address, so it is not read.`,
      };
    }
    if (entry.rules === "none") {
      return {
        allowed: false,
        kind: "robots",
        reason: `${url.hostname} could not be asked for its robots.txt, so it is not read for now.`,
      };
    }
    const verdict = entry.rules.isAllowed(url.href, ROBOTS_PRODUCT_TOKEN);
    return verdict === false
      ? {
          allowed: false,
          kind: "robots",
          reason: `The robots.txt of ${url.hostname} asks robots not to read this page (${url.pathname}), so it was not read.`,
        }
      : { allowed: true };
  }

  async #load(origin: string): Promise<Entry> {
    const robotsUrl = `${origin}/robots.txt`;
    const response = await safeGet(robotsUrl, {
      ...this.#fetchOptions,
      maxBytes: ROBOTS_MAX_BYTES,
      accept: "text/plain,*/*;q=0.1",
    });
    let entry: Entry;
    if (!response.ok) {
      entry = {
        until: this.#now() + ROBOTS_FAILURE_TTL_MS,
        rules: response.reason === "private" ? "private" : "none",
      };
    } else if (response.status >= 200 && response.status < 300) {
      entry = {
        until: this.#now() + ROBOTS_TTL_MS,
        rules: robotsParser(robotsUrl, response.body.toString("utf8")),
      };
    } else if (response.status >= 400 && response.status < 500) {
      entry = { until: this.#now() + ROBOTS_TTL_MS, rules: "all" };
    } else {
      entry = { until: this.#now() + ROBOTS_FAILURE_TTL_MS, rules: "none" };
    }
    if (this.#entries.size >= ROBOTS_CACHE_MAX) this.#entries.clear();
    this.#entries.set(origin, entry);
    return entry;
  }
}
