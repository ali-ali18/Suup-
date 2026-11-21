// Owns the list of search engines the SearXNG container may use, and what each one needs to reach.
// Declared data, one entry per engine: the name SearXNG knows it by, the exact host names it talks
// to (read from the engine's source in the pinned image), and why it is on or off by default.
// docs/BUSCA.md explains the choices; the user changes the list in the configuration (`web.search.engines`).

export const SEARXNG_IMAGE = "docker.io/searxng/searxng:2026.3.25-541c6c3cb";

export interface EngineSpec {
  /** Our id, equal to the engine's name in SearXNG. */
  id: string;
  /** What kind of access it is. `api`: a documented public API made for programs. `scrape`: it reads the engine's result page (HTML). */
  access: "api" | "scrape";
  /** On when the configuration says nothing. */
  defaultOn: boolean;
  /** The exact host names it connects to; `{lang}` is replaced by each language of `web.search.languages`. */
  hosts: readonly string[];
  /** One line for the docs and for `suup doctor`. */
  note: string;
}

export const ENGINES: readonly EngineSpec[] = [
  {
    id: "wikipedia",
    access: "api",
    defaultOn: true,
    hosts: ["{lang}.wikipedia.org"],
    note: "Wikipedia REST API (summaries), one host per language.",
  },
  {
    id: "arxiv",
    access: "api",
    defaultOn: true,
    hosts: ["export.arxiv.org"],
    note: "arXiv API, scientific papers.",
  },
  {
    id: "stackoverflow",
    access: "api",
    defaultOn: true,
    hosts: ["api.stackexchange.com"],
    note: "Stack Exchange API (Stack Overflow questions).",
  },
  {
    id: "github",
    access: "api",
    defaultOn: true,
    hosts: ["api.github.com"],
    note: "GitHub search API (repositories).",
  },
  {
    id: "duckduckgo",
    access: "scrape",
    defaultOn: false,
    hosts: ["html.duckduckgo.com", "duckduckgo.com"],
    note: "General web search by reading the HTML result page. Terms of use not verified: off until the owner turns it on.",
  },
  {
    id: "brave",
    access: "scrape",
    defaultOn: false,
    hosts: ["search.brave.com"],
    note: "General web search by reading the HTML result page. Terms of use not verified: off until the owner turns it on.",
  },
  {
    id: "startpage",
    access: "scrape",
    defaultOn: false,
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
