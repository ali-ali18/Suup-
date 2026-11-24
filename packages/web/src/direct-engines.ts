// Owns the search engines Suup asks itself, through their official APIs and with its honest user
// agent (docs/BUSCA.md, "O nome que o Suup usa"; research: docs/pesquisas/fase-4-busca-apis-diretas.md):
// Wikipedia (MediaWiki Action API), arXiv (Atom) and Stack Overflow (Stack Exchange API 2.3). The
// general web engines with a key (Tavily, Brave) are in general-engines.ts and share these types.
// Each engine answers with its hits or with a refusal that says why and, when it knows, for how
// long Suup must leave it alone. Answers are read structurally (JSON, a real XML parser, an HTML
// parser for the markup inside a snippet); an answer that is not what was expected fails closed.
// No pattern is used to read or to classify anything.
import type { WebSearchHit } from "@suup/core";
import { JSDOM } from "jsdom";
import { z } from "zod";
import type { DirectGet } from "./direct-http.js";
import { cleanUrl, clip, interleave } from "./hit-text.js";

const TITLE_MAX = 300;
const SNIPPET_MAX = 500;

export interface DirectSearchInput {
  query: string;
  /** The most hits wanted from this engine. */
  limit: number;
  /** A language code the caller asked for (Wikipedia and the general engines use it). */
  language?: string | undefined;
  /** The person's locale (`pt-BR`), from the configuration: the general engines use its country. */
  locale?: string | undefined;
  /** How recent the hits must be (only the general engines use it). */
  timeRange?: "day" | "month" | "year" | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Why an engine did not answer, for the queue of general engines: `quota` (the month's credits or
 * the plan's limit are used up), `rate_limited` (too many requests for a moment), `key_rejected`
 * (the service does not accept the key), `no_key` (there is none), `unavailable` (the service is
 * down or did not answer), `other` (the request failed in some other way).
 */
export type FailureKind =
  | "quota"
  | "rate_limited"
  | "key_rejected"
  | "no_key"
  | "unavailable"
  | "other";

export type DirectSearchResult =
  | {
      ok: true;
      hits: WebSearchHit[];
      /** The engine asked Suup to leave it alone for a while (Stack Exchange `backoff`, or its quota). */
      suspend?: { seconds: number; reason: string; kind?: FailureKind };
    }
  | {
      ok: false;
      /** One line for the model: what went wrong. */
      reason: string;
      /** How long Suup does not ask this engine again, when it is known. */
      suspendSeconds?: number;
      /** What kind of failure it was, when the engine knows (general engines always do). */
      kind?: FailureKind;
    };

export interface DirectEngine {
  /** Equal to the id in `ENGINES`. */
  id: string;
  /**
   * An engine that needs a key says whether it has one (looked up now, never cached), so the queue
   * can skip it without taking a place in Suup's limits. Absent: nothing is needed.
   */
  configured?(): Promise<boolean>;
  search(input: DirectSearchInput): Promise<DirectSearchResult>;
}

/** How long Suup leaves an engine alone after each kind of refusal. These are Suup's own choices (research, "Inferências"), not figures of any engine. */
export const DIRECT_SUSPENSION_SECONDS = { tooManyRequests: 180, accessDenied: 3600 } as const;
/** arXiv's own rule: no more than one request every three seconds, one connection at a time (docs/pesquisas/fase-4-busca-apis-diretas.md). */
export const ARXIV_INTERVAL_MS = 3000;
const MAX_SUSPENSION_SECONDS = 86_400;

/** The text of an HTML fragment (tags dropped, entities decoded). jsdom never runs a script from a fragment. */
export function htmlText(html: string): string {
  return JSDOM.fragment(html).textContent ?? "";
}

/** Runs one job at a time, each at least `intervalMs` after the previous one finished. */
export class Pacer {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  #lastEnd: number | undefined;

  constructor(
    intervalMs: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((done) => setTimeout(done, ms)),
  ) {
    this.#intervalMs = intervalMs;
    this.#now = now;
    this.#sleep = sleep;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#lastEnd !== undefined) {
        const wait = this.#lastEnd + this.#intervalMs - this.#now();
        if (wait > 0) await this.#sleep(wait);
      }
      try {
        return await job();
      } finally {
        this.#lastEnd = this.#now();
      }
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export const refusal = (
  reason: string,
  suspendSeconds?: number,
  kind?: FailureKind,
): DirectSearchResult => ({
  ok: false,
  reason,
  ...(suspendSeconds === undefined ? {} : { suspendSeconds }),
  ...(kind === undefined ? {} : { kind }),
});

/** What an HTTP status other than 200 means for every engine. */
function statusRefusal(status: number): DirectSearchResult {
  if (status === 429)
    return refusal("too many requests", DIRECT_SUSPENSION_SECONDS.tooManyRequests);
  if (status === 403) return refusal("access denied", DIRECT_SUSPENSION_SECONDS.accessDenied);
  return refusal(`HTTP ${status}`);
}

async function ask(
  get: DirectGet,
  url: string,
  accept: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; status: number; body: string } | { ok: false; result: DirectSearchResult }> {
  try {
    const response = await get(url, { accept, ...(signal === undefined ? {} : { signal }) });
    return { ok: true, status: response.status, body: response.body };
  } catch (error) {
    return {
      ok: false,
      result: refusal(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Wikipedia

const wikipediaAnswer = z.object({
  error: z.object({ code: z.string(), info: z.string().optional() }).optional(),
  query: z
    .object({
      search: z.array(z.object({ title: z.string(), snippet: z.string().optional() })),
    })
    .optional(),
});

export function wikipediaEngine(options: {
  get: DirectGet;
  /** The language editions Suup may ask (hosts `<lang>.wikipedia.org`). */
  languages: readonly string[];
}): DirectEngine {
  const one = async (language: string, input: DirectSearchInput): Promise<DirectSearchResult> => {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: input.query,
      srlimit: String(input.limit),
      srprop: "snippet",
      srnamespace: "0",
      format: "json",
      formatversion: "2",
    });
    const url = `https://${language}.wikipedia.org/w/api.php?${params.toString()}`;
    const got = await ask(options.get, url, "application/json", input.signal);
    if (!got.ok) return got.result;
    if (got.status !== 200) return statusRefusal(got.status);
    const parsed = wikipediaAnswer.safeParse(parseJson(got.body));
    if (!parsed.success) return refusal("Wikipedia answered in a format that was not expected");
    if (parsed.data.error !== undefined) {
      const { code, info } = parsed.data.error;
      return refusal(
        `Wikipedia refused the search (${code}${info === undefined ? "" : `: ${clip(info, 200)}`})`,
        code === "ratelimited" ? DIRECT_SUSPENSION_SECONDS.tooManyRequests : undefined,
      );
    }
    if (parsed.data.query === undefined)
      return refusal("Wikipedia answered in a format that was not expected");
    const hits: WebSearchHit[] = [];
    for (const item of parsed.data.query.search) {
      const link = new URL(`https://${language}.wikipedia.org/wiki/`);
      link.pathname = `/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`;
      const url = cleanUrl(link.href);
      if (url === undefined) continue;
      hits.push({
        title: clip(item.title, TITLE_MAX) || url,
        url,
        snippet: clip(htmlText(item.snippet ?? ""), SNIPPET_MAX),
        engine: "wikipedia",
      });
    }
    return { ok: true, hits };
  };

  return {
    id: "wikipedia",
    async search(input) {
      const wanted = input.language?.trim().toLowerCase();
      const base = wanted === undefined || wanted === "" ? undefined : (wanted.split("-")[0] ?? "");
      const chosen =
        base !== undefined && options.languages.includes(base) ? [base] : [...options.languages];
      if (chosen.length === 0) return refusal("no Wikipedia language is configured");
      const lists: WebSearchHit[][] = [];
      let last: DirectSearchResult | undefined;
      for (const language of chosen) {
        // One language after the other, never in parallel: the load on the API stays small.
        const result = await one(language, input);
        if (result.ok) lists.push(result.hits);
        else last = result;
      }
      if (lists.length === 0 && last !== undefined) return last;
      return { ok: true, hits: interleave(lists).slice(0, input.limit) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// arXiv

const ATOM = "http://www.w3.org/2005/Atom";
const ARXIV_OPERATORS: readonly string[] = ["AND", "OR", "ANDNOT"];
const ARXIV_SYNTAX: readonly string[] = ['"', "(", ")", ":", "+", "&", "#", "%", "\\", "[", "]"];

/**
 * The `search_query` for a plain-words query: every word must appear, in any field (`all:`). The
 * characters of the query language and the three operators written as a word are left out, so a
 * word can never change the shape of the query. Words are found by splitting at blanks.
 */
export function arxivSearchQuery(query: string): string | undefined {
  const terms: string[] = [];
  let word = "";
  const flush = () => {
    if (word !== "" && !ARXIV_OPERATORS.includes(word)) terms.push(`all:${word}`);
    word = "";
  };
  for (const ch of query) {
    if (ch.trim() === "") flush();
    else if (!ARXIV_SYNTAX.includes(ch)) word += ch;
  }
  flush();
  return terms.length === 0 ? undefined : terms.join(" AND ");
}

function childText(parent: Element, name: string): string | undefined {
  for (const child of Array.from(parent.children)) {
    if (child.namespaceURI === ATOM && child.localName === name) return child.textContent ?? "";
  }
  return undefined;
}

function alternateLink(entry: Element): string | undefined {
  for (const child of Array.from(entry.children)) {
    if (child.namespaceURI !== ATOM || child.localName !== "link") continue;
    if (child.getAttribute("rel") === "alternate") return child.getAttribute("href") ?? undefined;
  }
  return undefined;
}

/** `http://arxiv.org/abs/...` is written as `https://arxiv.org/abs/...`: the same page, on the secure address. */
function secureArxivUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.hostname === "arxiv.org") url.protocol = "https:";
    return cleanUrl(url.href);
  } catch {
    return undefined;
  }
}

export function parseArxivAnswer(xml: string): DirectSearchResult {
  let document: Document;
  try {
    document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  } catch {
    return refusal("arXiv answered with something that is not well-formed XML");
  }
  const feed = document.documentElement;
  if (feed.namespaceURI !== ATOM || feed.localName !== "feed") {
    return refusal("arXiv answered in a format that was not expected (no Atom feed)");
  }
  const hits: WebSearchHit[] = [];
  for (const entry of Array.from(feed.children)) {
    if (entry.namespaceURI !== ATOM || entry.localName !== "entry") continue;
    const id = childText(entry, "id") ?? "";
    if (
      id.startsWith("http://arxiv.org/api/errors") ||
      id.startsWith("https://arxiv.org/api/errors")
    ) {
      // The documented error: a single entry whose summary says what is wrong.
      return refusal(
        `arXiv refused the search: ${clip(childText(entry, "summary") ?? "no explanation", 200)}`,
      );
    }
    const url = secureArxivUrl(alternateLink(entry) ?? id);
    if (url === undefined) continue;
    hits.push({
      title: clip(childText(entry, "title") ?? "", TITLE_MAX) || url,
      url,
      snippet: clip(childText(entry, "summary") ?? "", SNIPPET_MAX),
      engine: "arxiv",
    });
  }
  return { ok: true, hits };
}

export function arxivEngine(options: {
  get: DirectGet;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}): DirectEngine {
  const pacer = new Pacer(options.intervalMs ?? ARXIV_INTERVAL_MS, options.now, options.sleep);
  return {
    id: "arxiv",
    async search(input) {
      const searchQuery = arxivSearchQuery(input.query);
      if (searchQuery === undefined) return refusal("the query has no word arXiv can search for");
      const params = new URLSearchParams({
        search_query: searchQuery,
        start: "0",
        max_results: String(input.limit),
        sortBy: "relevance",
        sortOrder: "descending",
      });
      const url = `https://export.arxiv.org/api/query?${params.toString()}`;
      // One request at a time, three seconds apart (arXiv's terms of use for its APIs).
      const got = await pacer.run(() =>
        ask(options.get, url, "application/atom+xml", input.signal),
      );
      if (!got.ok) return got.result;
      if (got.status !== 200) return statusRefusal(got.status);
      return parseArxivAnswer(got.body);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stack Overflow

const stackAnswer = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        score: z.number().optional(),
        answer_count: z.number().optional(),
        is_answered: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  backoff: z.number().optional(),
  quota_remaining: z.number().optional(),
  error_id: z.number().optional(),
  error_name: z.string().optional(),
  error_message: z.string().optional(),
});

export function stackOverflowEngine(options: { get: DirectGet }): DirectEngine {
  return {
    id: "stackoverflow",
    async search(input) {
      const params = new URLSearchParams({
        q: input.query,
        site: "stackoverflow",
        order: "desc",
        sort: "relevance",
        pagesize: String(input.limit),
      });
      const url = `https://api.stackexchange.com/2.3/search/advanced?${params.toString()}`;
      const got = await ask(options.get, url, "application/json", input.signal);
      if (!got.ok) return got.result;
      const parsed = stackAnswer.safeParse(parseJson(got.body));
      if (!parsed.success) {
        return got.status === 200
          ? refusal("Stack Overflow answered in a format that was not expected")
          : statusRefusal(got.status);
      }
      const data = parsed.data;
      if (data.error_id !== undefined || data.error_name !== undefined) {
        const name = data.error_name ?? `error ${data.error_id}`;
        const detail = data.error_message === undefined ? "" : `: ${clip(data.error_message, 200)}`;
        // `throttle_violation` and a quota that is used up say "stop"; the API does not say for how long.
        const stop = data.error_name === "throttle_violation" || got.status === 429;
        return refusal(
          `Stack Overflow refused the search (${name}${detail})`,
          stop ? DIRECT_SUSPENSION_SECONDS.accessDenied : undefined,
        );
      }
      if (got.status !== 200) return statusRefusal(got.status);
      if (data.items === undefined)
        return refusal("Stack Overflow answered in a format that was not expected");
      const hits: WebSearchHit[] = [];
      for (const item of data.items) {
        const link = cleanUrl(item.link);
        if (link === undefined) continue;
        const parts: string[] = [];
        if (item.score !== undefined) parts.push(`score ${item.score}`);
        if (item.answer_count !== undefined)
          parts.push(`${item.answer_count} answer${item.answer_count === 1 ? "" : "s"}`);
        if (item.is_answered === true) parts.push("has an accepted or upvoted answer");
        if (item.tags !== undefined && item.tags.length > 0)
          parts.push(`tags: ${item.tags.join(", ")}`);
        hits.push({
          title: clip(htmlText(item.title), TITLE_MAX) || link,
          url: link,
          snippet: clip(parts.join("; "), SNIPPET_MAX),
          engine: "stackoverflow",
        });
      }
      // The API asks callers to wait (`backoff`, in seconds) or has no quota left: keep the hits, leave it alone.
      let suspend: { seconds: number; reason: string } | undefined;
      if (data.backoff !== undefined && data.backoff > 0) {
        suspend = {
          seconds: Math.min(Math.ceil(data.backoff), MAX_SUSPENSION_SECONDS),
          reason: `the API asked callers to wait ${Math.ceil(data.backoff)} s (backoff)`,
        };
      } else if (data.quota_remaining !== undefined && data.quota_remaining <= 0) {
        suspend = {
          seconds: DIRECT_SUSPENSION_SECONDS.accessDenied,
          reason: "the daily quota of the API is used up",
        };
      }
      return { ok: true, hits, ...(suspend === undefined ? {} : { suspend }) };
    },
  };
}
