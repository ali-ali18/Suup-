// Owns asking our SearXNG container for results and reading its JSON answer into `WebSearchOutcome`.
// The container is reached through a `SearxBackend` (HTTP to a URL, or `docker exec` into the
// container), so the parsing and the messages here do not depend on how it is reached.
import type { WebSearchHit, WebSearchOutcome, WebSearchRequest } from "@suup/core";
import { z } from "zod";
import { engineById } from "./engines.js";
import { DEFAULT_CACHE_TTL_MS, type SearchCache, searchCacheKey } from "./search-cache.js";
import type { SearchGovernor } from "./search-governor.js";

export const SEARCH_MAX_RESULTS = 10;
const TITLE_MAX = 300;
const SNIPPET_MAX = 500;
const URL_MAX = 1000;

/** Sends one search to the container and returns the JSON text it answered. Throws with a readable message. */
export interface SearxBackend {
  query(params: URLSearchParams, signal?: AbortSignal): Promise<string>;
}

const answerSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        engine: z.string().optional(),
        engines: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  unresponsive_engines: z.array(z.tuple([z.string(), z.string()]).rest(z.unknown())).default([]),
});

export interface SearchOptions {
  backend: SearxBackend;
  /** The engines that are turned on (what a search asks, unless the limits or a suspension leave some out). */
  engines: readonly string[];
  maxResults?: number;
  /** Suup's own rate limits and the memory of suspended engines. Without it every search goes out at once. */
  governor?: SearchGovernor;
  /** Answers an identical search made recently. Without it nothing is cached. */
  cache?: SearchCache;
  /** How long a cached answer lives. Default 3 hours. */
  cacheTtlMs?: number;
  now?: () => number;
}

type SearchOk = Extract<WebSearchOutcome, { ok: true }>;

export function createSearch(
  options: SearchOptions,
): (request: WebSearchRequest) => Promise<WebSearchOutcome> {
  const clock = options.now ?? Date.now;
  const cap = options.maxResults ?? SEARCH_MAX_RESULTS;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  return async (request) => {
    const query = request.query.trim();
    if (query === "") return { ok: false, reason: "failed", message: "The search query is empty." };
    const wanted = Math.min(Math.max(request.limit ?? 5, 1), cap);
    const startedAt = clock();

    // 1. An identical search made recently is answered from the cache.
    const key =
      options.cache === undefined
        ? undefined
        : searchCacheKey({
            query,
            engines: options.engines,
            language: request.language,
            timeRange: request.timeRange,
          });
    if (options.cache !== undefined && key !== undefined) {
      const entry = await options.cache.get(key, startedAt).catch(() => undefined);
      if (entry !== undefined) {
        return {
          ok: true,
          query,
          hits: entry.hits.slice(0, wanted),
          suspended: entry.suspended,
          engines: entry.engines,
          cached: {
            at: new Date(entry.storedAt).toISOString(),
            ageSeconds: Math.max(0, Math.round((startedAt - entry.storedAt) / 1000)),
          },
        };
      }
    }

    // 2. Engines Suup already knows to be suspended are not asked.
    const known = options.governor?.suspended() ?? new Map();
    const skipped = options.engines.filter((engine) => known.has(engine));
    const candidates = options.engines.filter((engine) => !known.has(engine));
    const skippedAnswer = skipped.map((engine) => ({
      engine,
      reason: `Suspended: ${known.get(engine)?.reason ?? ""}`,
      retryInSeconds: known.get(engine)?.retryInSeconds ?? 0,
    }));
    if (options.governor !== undefined && candidates.length === 0 && options.engines.length > 0) {
      return {
        ok: true,
        query,
        hits: [],
        suspended: skippedAnswer,
        engines: [],
        ...generalState(options.engines, skippedAnswer, []),
      };
    }

    // 3. Suup's own limits: wait a little, leave out an engine that is over its limit, or say when to come back.
    let ask = candidates;
    let throttled: { engine: string; retryInSeconds: number }[] = [];
    let waitedMs = 0;
    if (options.governor !== undefined) {
      const grant = await options.governor.acquire(candidates, request.signal);
      if (!grant.ok) {
        return {
          ok: false,
          reason: "rate_limited",
          retryInSeconds: grant.retryInSeconds,
          message:
            grant.scope === "overall"
              ? `Too many searches in the last minute. Suup limits how often it asks the search engines; try again in about ${grant.retryInSeconds} s.`
              : `Every engine for this search is at its limit for the minute. Try again in about ${grant.retryInSeconds} s.`,
        };
      }
      ask = grant.engines;
      throttled = grant.throttled;
      waitedMs = grant.waitedMs;
    }

    // 4. The search itself.
    const params = new URLSearchParams({ q: query, format: "json", safesearch: "1" });
    // The engines are named, not left to the categories: a default query asks only the `general`
    // ones, and the engines of papers, code and Q&A would never be asked.
    if (ask.length > 0) params.set("engines", ask.join(","));
    if (request.language !== undefined && request.language !== "")
      params.set("language", request.language);
    if (request.timeRange !== undefined) params.set("time_range", request.timeRange);
    let text: string;
    try {
      text = await options.backend.query(params, request.signal);
    } catch (error) {
      return {
        ok: false,
        reason: "unavailable",
        message: `The search service did not answer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const parsed = parseSearxAnswer(text, query, cap, ask);
    if (!parsed.ok) return parsed;

    // 5. What the answer says about the engines, kept for the next search.
    const retry = options.governor?.learn(ask, parsed.suspended) ?? new Map<string, number>();
    const suspended = [
      ...parsed.suspended.map((u) => {
        const seconds = retry.get(u.engine);
        return seconds === undefined ? u : { ...u, retryInSeconds: seconds };
      }),
      ...skippedAnswer,
    ];
    const outcome: SearchOk = {
      ...parsed,
      suspended,
      ...(throttled.length === 0 ? {} : { throttled }),
      ...(waitedMs >= 1000 ? { waitedSeconds: Math.round(waitedMs / 1000) } : {}),
      ...generalState(options.engines, suspended, throttled),
    };
    if (options.cache !== undefined && key !== undefined && outcome.hits.length > 0) {
      await options.cache
        .set(
          key,
          {
            query,
            engines: outcome.engines,
            hits: outcome.hits,
            suspended: outcome.suspended.map(({ engine, reason }) => ({ engine, reason })),
            storedAt: clock(),
          },
          ttl,
        )
        .catch(() => undefined);
    }
    return { ...outcome, hits: outcome.hits.slice(0, wanted) };
  };
}

/** Whether every general web engine that is turned on is out of reach for now, and until when. */
function generalState(
  engines: readonly string[],
  suspended: readonly { engine: string; retryInSeconds?: number }[],
  throttled: readonly { engine: string; retryInSeconds: number }[],
): { generalUnavailable?: { retryInSeconds?: number } } {
  const general = engines.filter((id) => engineById(id)?.general === true);
  if (general.length === 0) return {};
  const out: number[] = [];
  for (const id of general) {
    const s = suspended.find((u) => u.engine === id);
    const t = throttled.find((u) => u.engine === id);
    if (s === undefined && t === undefined) return {};
    const seconds = s?.retryInSeconds ?? t?.retryInSeconds;
    if (seconds !== undefined) out.push(seconds);
  }
  return { generalUnavailable: out.length === 0 ? {} : { retryInSeconds: Math.min(...out) } };
}

/** Reads SearXNG's JSON answer. Only http(s) hits are kept; text is cut; the same URL appears once. */
export function parseSearxAnswer(
  text: string,
  query: string,
  limit: number,
  engines: readonly string[],
): WebSearchOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "failed",
      message:
        "The search service answered with something that is not JSON (is `json` enabled in its formats?).",
    };
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "failed",
      message: "The search service answered in a format that was not expected.",
    };
  }
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.results) {
    const url = cleanUrl(raw.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title: clip(raw.title ?? "", TITLE_MAX) || url,
      url,
      snippet: clip(raw.content ?? "", SNIPPET_MAX),
      engine: raw.engine ?? raw.engines?.[0] ?? "unknown",
    });
    if (hits.length >= limit) break;
  }
  const suspended = parsed.data.unresponsive_engines.map(([engine, reason]) => ({
    engine,
    reason,
  }));
  return { ok: true, query, hits, suspended, engines: [...engines] };
}

function cleanUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length > URL_MAX) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** One line of plain text: control characters and line breaks become spaces, and the text is cut. */
export function clip(text: string, max: number): string {
  let out = "";
  let space = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const blank = code < 0x20 || code === 0x7f || ch === " " || ch === " ";
    if (blank) {
      space = out !== "";
      continue;
    }
    if (space) out += " ";
    space = false;
    out += ch;
    if (out.length >= max) return `${out.slice(0, max - 1)}…`;
  }
  return out;
}

/** A backend that talks HTTP to a SearXNG instance (`format=json` must be enabled there). */
export function httpSearxBackend(baseUrl: string, timeoutMs = 20_000): SearxBackend {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    async query(params, signal) {
      const url = new URL("search", base);
      url.search = params.toString();
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
      if (response.status === 403) {
        throw new Error("HTTP 403: the JSON format is not enabled in the search service settings");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    },
  };
}
