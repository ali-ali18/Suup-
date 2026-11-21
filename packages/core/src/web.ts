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
