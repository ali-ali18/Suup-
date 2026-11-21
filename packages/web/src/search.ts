// Owns asking our SearXNG container for results and reading its JSON answer into `WebSearchOutcome`.
// The container is reached through a `SearxBackend` (HTTP to a URL, or `docker exec` into the
// container), so the parsing and the messages here do not depend on how it is reached.
import type { WebSearchHit, WebSearchOutcome, WebSearchRequest } from "@suup/core";
import { z } from "zod";

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
  /** The engines that were asked (for the answer's `engines` and the message). */
  engines: readonly string[];
  maxResults?: number;
}

export function createSearch(
  options: SearchOptions,
): (request: WebSearchRequest) => Promise<WebSearchOutcome> {
  return async (request) => {
    const query = request.query.trim();
    if (query === "") return { ok: false, reason: "failed", message: "The search query is empty." };
    const params = new URLSearchParams({ q: query, format: "json", safesearch: "1" });
    // The engines are named, not left to the categories: a default query asks only the `general`
    // ones, and the engines of papers, code and Q&A would never be asked.
    if (options.engines.length > 0) params.set("engines", options.engines.join(","));
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
    const limit = Math.min(
      Math.max(request.limit ?? 5, 1),
      options.maxResults ?? SEARCH_MAX_RESULTS,
    );
    return parseSearxAnswer(text, query, limit, options.engines);
  };
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
