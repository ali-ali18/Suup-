// Owns what the web tools (`web_search`, `web_read`) may use. Tools see only this interface: the
// implementation (a SearXNG container, a reader service, a headless renderer) lives in `@suup/web`
// and is bound to the run by the runtime, the same way `NetworkAccess` is. Nothing here names a
// provider: a search backend is whatever the runtime wired.

/** One search hit, as the tool shows it. All text comes from outside: it is data, never instructions. */
export interface WebSearchHit {
  title: string;
  url: string;
  /** The snippet the engine gave; may be empty. */
  snippet: string;
  /** The engine that found it (for example `wikipedia`). */
  engine: string;
}

export interface WebSearchRequest {
  query: string;
  /** How many hits at most (the service also caps it). */
  limit?: number;
  /** A language code the engines understand (`en`, `pt`...). Default: all. */
  language?: string;
  /** `day`, `month` or `year`. */
  timeRange?: "day" | "month" | "year";
  signal?: AbortSignal;
}

export type WebSearchOutcome =
  | {
      ok: true;
      query: string;
      hits: WebSearchHit[];
      /** Engines that did not answer (captcha, rate limit, timeout...) and the reason each gave. */
      suspended: { engine: string; reason: string }[];
      /** Engines that were asked. */
      engines: string[];
    }
  | { ok: false; reason: "unavailable" | "failed"; message: string };

export interface WebReadRequest {
  url: string;
  /** Run the page in a headless browser first (pages that build their content with JavaScript). */
  render?: boolean;
  signal?: AbortSignal;
}

/** A page turned into Markdown. All text comes from outside. */
export interface WebPage {
  /** The URL after redirects. */
  url: string;
  requestedUrl: string;
  status: number;
  title?: string;
  byline?: string;
  /** As the page declares it (not parsed). */
  published?: string;
  siteName?: string;
  /** `readability` found a main article; `fallback` is the whole body text. */
  extraction: "readability" | "fallback" | "plain";
  markdown: string;
  /**
   * The addresses of the page's own `<a href>` links, resolved against its URL, normalized and without
   * repeats, in page order (capped). Collected from the document structure by the reader, not from
   * the text. `web_read` may open them later without a card.
   */
  links?: string[];
  /** The text was cut at the limit; `fullLength` is the length before the cut. */
  truncated: boolean;
  fullLength: number;
  rendered: boolean;
}

export type WebReadOutcome =
  | { ok: true; page: WebPage }
  | {
      ok: false;
      /**
       * `robots`: the site's robots.txt asks robots not to read it. `private`: the address is not a
       * public one. `not_text`: a file that is not a page. `unavailable`: no way to read right now.
       */
      reason:
        | "robots"
        | "private"
        | "not_text"
        | "http"
        | "too_large"
        | "timeout"
        | "invalid_url"
        | "unavailable"
        | "failed";
      message: string;
      status?: number;
    };

/** What the tools may do on the web, bound to the run by the runtime. */
export interface WebAccess {
  /** Whether `search` can work right now (the search service is up). */
  readonly searchAvailable: boolean;
  /**
   * Whether `read` goes through the reader service (public pages, no card). `false`: the owner
   * turned it off, and `web_read` uses the bot's own allowlisted machine instead.
   */
  readonly readerEnabled: boolean;
  /** Whether `read` can render with JavaScript (the renderer container is available). */
  readonly renderAvailable: boolean;
  search(request: WebSearchRequest): Promise<WebSearchOutcome>;
  read(request: WebReadRequest): Promise<WebReadOutcome>;
  /** HTML already downloaded (by the bot's machine) to Markdown. No network. */
  extract(input: { html: string; url: string }): Promise<WebPage | undefined>;
}

// ---- Which URLs may be read without a card (docs/BUSCA.md, "A leitura só abre o que já apareceu") ----

/**
 * Where a URL that `web_read` may open without a card came from. `approved` is not one of these:
 * it marks a read the user cleared on a card, because the address was in none of the three.
 */
export type WebUrlSource = "user_message" | "search_result" | "page_link";

/**
 * The URL in the one form two URLs are compared in: parsed with the WHATWG `URL` API, which writes
 * the scheme and the host in lower case and leaves out a default port; the fragment is dropped.
 * The path and the query stay exactly as given (a trailing slash is a different URL, and
 * percent-encoding is not touched). Only `http:` and `https:`. `undefined` when it is not one.
 */
export function normalizeWebUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  return url.href;
}

/** What a user message may end with right after an address written in running text. */
const TRAILING_MARKS: ReadonlySet<string> = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  ">",
  '"',
  "'",
  "*",
  "_",
]);
/** Characters that end an address in running text (blanks and the brackets that wrap one). */
const URL_BREAKS: ReadonlySet<string> = new Set(["<", ">", '"', "'", "`", "\\", "|"]);
const MAX_STRIPPED = 6;

/**
 * The URLs written in a text, normalized. Structured, not a pattern: the text is cut at blanks and
 * at the characters that wrap an address, every place that starts with `http://` or `https://`
 * is read with the `URL` API, and an address that may end with the mark of the sentence around it
 * (`.`, `)`...) is offered with and without it, so both forms count as written by the person.
 */
export function urlsInText(text: string): string[] {
  const found = new Set<string>();
  const tokens: string[] = [];
  let current = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || code === 0xa0 || URL_BREAKS.has(ch)) {
      if (current !== "") tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") tokens.push(current);
  for (const token of tokens) {
    for (const scheme of ["http://", "https://"]) {
      let from = token.indexOf(scheme);
      while (from !== -1) {
        let candidate = token.slice(from);
        for (let strip = 0; strip <= MAX_STRIPPED && candidate !== ""; strip++) {
          const normalized = normalizeWebUrl(candidate);
          if (normalized !== undefined) found.add(normalized);
          const last = candidate.slice(-1);
          if (!TRAILING_MARKS.has(last)) break;
          candidate = candidate.slice(0, -1);
        }
        from = token.indexOf(scheme, from + scheme.length);
      }
    }
  }
  return [...found];
}

/** At most this many URLs one tool result may add to what the run has seen. */
export const WEB_URLS_PER_RESULT_MAX = 500;
