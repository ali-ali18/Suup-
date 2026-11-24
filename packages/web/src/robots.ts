// Owns "may our robot read this URL": the site's robots.txt, read with `robots-parser` (rule
// semantics are that library's, not ours), cached per host. Our honest user agent names the product
// token `SuupBot`.
//
// What the file's status means (the usual convention for robots.txt): 2xx, the rules apply; 4xx (no
// file, or not allowed to see it), no rules, so everything is allowed; a server error (5xx), the
// site is treated as closed for a while (we do not guess). RFC 9309 itself could not be read when
// this was researched (docs/pesquisas/fase-4-busca-na-web.md), so this follows the library and that
// convention.
//
// A robots.txt that could not be FETCHED at all (no DNS answer, no route, a refused connection, a
// TLS failure, no answer in time) is not the site saying anything: the site stays closed for a
// short while (we still do not read what we could not ask about), but the verdict says it was a
// connection problem on this side (`unreachable`), with what failed for the logs
// (`FetchDiagnostic`). It is never reported as the site forbidding robots.
import robotsParser from "robots-parser";
import { type FetchDiagnostic, type SafeFetchOptions, safeGet } from "./safe-fetch.js";

export const ROBOTS_PRODUCT_TOKEN = "SuupBot";
export const ROBOTS_MAX_BYTES = 512_000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;
/** A robots.txt we could not reach is asked again soon: the problem is usually ours, and passes. */
const ROBOTS_UNREACHABLE_TTL_MS = 60 * 1000;
const ROBOTS_CACHE_MAX = 2000;

export type RobotsVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      /**
       * `robots`: the file asks robots not to read the page. `private`: not a public address.
       * `server_error`: the site answered its robots.txt with a server error (`status`).
       * `unreachable`: the robots.txt could not be fetched from here (DNS, route, TLS, time).
       */
      kind: "robots" | "private" | "server_error" | "unreachable";
      status?: number;
      /** For `unreachable`: what failed, for the logs only. */
      diagnostic?: FetchDiagnostic;
    };

interface Entry {
  until: number;
  rules:
    | ReturnType<typeof robotsParser>
    | "all"
    | "private"
    | { serverError: number }
    | { unreachable: string; diagnostic?: FetchDiagnostic };
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
    if ("serverError" in entry.rules) {
      return {
        allowed: false,
        kind: "server_error",
        status: entry.rules.serverError,
        reason: `${url.hostname} answered its robots.txt with a server error (HTTP ${entry.rules.serverError}), so the site is not read for a few minutes.`,
      };
    }
    if ("unreachable" in entry.rules) {
      const slow = entry.rules.diagnostic?.stage === "timeout";
      return {
        allowed: false,
        kind: "unreachable",
        reason: slow
          ? `${url.hostname} did not answer in time (its robots.txt was asked first), so the page was not read. The site is slow or not answering right now; it is not refusing.`
          : `Could not reach ${url.hostname} from here right now, so the page was not read: ${entry.rules.unreachable} The site did not refuse anything; it may work again in a few minutes.`,
        ...(entry.rules.diagnostic === undefined ? {} : { diagnostic: entry.rules.diagnostic }),
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
      entry =
        response.reason === "private"
          ? { until: this.#now() + ROBOTS_FAILURE_TTL_MS, rules: "private" }
          : {
              until: this.#now() + ROBOTS_UNREACHABLE_TTL_MS,
              rules: {
                unreachable: response.message,
                ...(response.diagnostic === undefined ? {} : { diagnostic: response.diagnostic }),
              },
            };
    } else if (response.status >= 200 && response.status < 300) {
      entry = {
        until: this.#now() + ROBOTS_TTL_MS,
        rules: robotsParser(robotsUrl, response.body.toString("utf8")),
      };
    } else if (response.status >= 400 && response.status < 500) {
      entry = { until: this.#now() + ROBOTS_TTL_MS, rules: "all" };
    } else {
      entry = {
        until: this.#now() + ROBOTS_FAILURE_TTL_MS,
        rules: { serverError: response.status },
      };
    }
    if (this.#entries.size >= ROBOTS_CACHE_MAX) this.#entries.clear();
    this.#entries.set(origin, entry);
    return entry;
  }
}
