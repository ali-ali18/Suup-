// Owns the list of search engines Suup can ask, and what each one needs to reach. Declared data,
// one entry per engine: how Suup reaches it (`direct`: Suup itself, through the official API and
// with its honest user agent, direct-engines.ts; `searxng`: through the SearXNG container, by the
// name SearXNG knows it by), the exact host names it talks to, and why it is on or off by default.
// docs/BUSCA.md explains the choices; the user changes the list in the configuration (`web.search.engines`).

export const SEARXNG_IMAGE = "docker.io/searxng/searxng:2026.3.25-541c6c3cb";

export interface EngineSpec {
  /** Our id; for a `searxng` engine it is also the engine's name in SearXNG. */
  id: string;
  /**
   * Who asks the engine. `direct`: Suup, with the official API and its honest user agent.
   * `searxng`: the SearXNG container (docs/BUSCA.md, "O nome que o Suup usa").
   */
  via: "direct" | "searxng";
  /** What kind of access it is. `api`: a documented public API made for programs. `scrape`: it reads the engine's result page (HTML). */
  access: "api" | "scrape";
  /** On when the configuration says nothing. */
  defaultOn: boolean;
  /** A general web search engine (the open web), as opposed to an encyclopedia, papers, code or Q&A. */
  general: boolean;
  /**
   * The most searches Suup sends to this engine in a minute (the tool's own politeness, before the
   * search service is asked; `web.search.limits.perEngine` overrides it). General engines read a
   * result page and block an address that asks too much, so theirs is low.
   */
  perMinute: number;
  /**
   * A `searxng` engine whose module reads its own `User-Agent` from this attribute (set from the
   * settings file), so Suup can give it the honest one. Absent: SearXNG decides (docs/BUSCA.md, "O nome que o Suup usa").
   */
  userAgentAttribute?: string;
  /** The exact host names it connects to; `{lang}` is replaced by each language of `web.search.languages`. */
  hosts: readonly string[];
  /** One line for the docs and for `suup doctor`. */
  note: string;
}

export const ENGINES: readonly EngineSpec[] = [
  {
    id: "wikipedia",
    via: "direct",
    access: "api",
    defaultOn: true,
    general: false,
    perMinute: 30,
    hosts: ["{lang}.wikipedia.org"],
    note: "Wikipedia, searched with the MediaWiki Action API (list=search), one host per language, with the honest user agent.",
  },
  {
    id: "arxiv",
    via: "direct",
    access: "api",
    defaultOn: true,
    general: false,
    perMinute: 15,
    hosts: ["export.arxiv.org"],
    note: "arXiv API (Atom), scientific papers, at most one request every three seconds (arXiv terms of use), with the honest user agent.",
  },
  {
    id: "stackoverflow",
    via: "direct",
    access: "api",
    defaultOn: true,
    general: false,
    perMinute: 10,
    hosts: ["api.stackexchange.com"],
    note: "Stack Exchange API 2.3 (Stack Overflow questions), honouring `backoff` and the quota, with the honest user agent.",
  },
  {
    id: "duckduckgo",
    via: "searxng",
    access: "scrape",
    defaultOn: true,
    general: true,
    perMinute: 6,
    userAgentAttribute: "_HTTP_User_Agent",
    // The engine module of the pinned image (searx/engines/duckduckgo.py) posts only to
    // `ddg_url = "https://html.duckduckgo.com/html/"`; `duckduckgo.com` appears there only in
    // `fetch_traits` (an offline maintenance function, never run by a search) and in other engines
    // (images, news), which are not turned on.
    hosts: ["html.duckduckgo.com"],
    note: "General web search by reading the HTML result page. On by the owner's decision, with a low rate (6 a minute) and Suup's honest user agent; it may answer with a captcha, and then the tool stops asking it for an hour.",
  },
  {
    id: "brave",
    via: "searxng",
    access: "scrape",
    defaultOn: false,
    general: false,
    perMinute: 6,
    hosts: ["search.brave.com"],
    note: "General web search by reading the HTML result page. Terms of use not verified: off until the owner turns it on.",
  },
  {
    id: "startpage",
    via: "searxng",
    access: "scrape",
    defaultOn: false,
    general: false,
    perMinute: 6,
    hosts: ["www.startpage.com"],
    note: "General web search by reading the HTML result page. Terms of use not verified: off until the owner turns it on.",
  },
];

export const DEFAULT_ENGINES: readonly string[] = ENGINES.filter((e) => e.defaultOn).map(
  (e) => e.id,
);
export const DEFAULT_LANGUAGES: readonly string[] = ["en", "pt"];

export function engineById(id: string): EngineSpec | undefined {
  return ENGINES.find((engine) => engine.id === id);
}

/** The ids that are not known engines (the configuration is refused with these). */
export function unknownEngines(ids: readonly string[]): string[] {
  return ids.filter((id) => engineById(id) === undefined);
}

/** The exact host names the search container may reach for these engines and languages, sorted. */
export function engineHosts(ids: readonly string[], languages: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const id of ids) {
    const engine = engineById(id);
    if (engine === undefined) continue;
    for (const host of engine.hosts) {
      if (host.includes("{lang}")) {
        for (const lang of languages) hosts.add(host.replaceAll("{lang}", lang));
      } else {
        hosts.add(host);
      }
    }
  }
  return [...hosts].sort();
}

/** The ids Suup asks itself (`via: "direct"`). */
export function directEngineIds(ids: readonly string[]): string[] {
  return ids.filter((id) => engineById(id)?.via === "direct");
}

/** The ids the SearXNG container asks (`via: "searxng"`); unknown ids are left out. */
export function searxEngineIds(ids: readonly string[]): string[] {
  return ids.filter((id) => engineById(id)?.via === "searxng");
}
