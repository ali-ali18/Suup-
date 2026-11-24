// Owns the list of search engines Suup can ask, and what each one needs to reach. Declared data,
// one entry per engine: the exact host names it talks to, whether it needs a key, whether it is a
// general web engine (one of the queue of official APIs, tried in order) or a specialised one
// (asked together with the others), and what the terms of the service allow. Every engine is asked
// by Suup itself, through its official API and with its honest user agent (direct-engines.ts,
// general-engines.ts). docs/BUSCA.md explains the choices; the user changes the list in the
// configuration (`web.search.engines`).

export interface EngineSpec {
  /** Our id. */
  id: string;
  /** What the person sees ("Tavily", "Brave Search"). */
  label: string;
  /** On when the configuration says nothing. */
  defaultOn: boolean;
  /**
   * A general web search engine (the open web), as opposed to an encyclopedia, papers, code or
   * Q&A. General engines are a QUEUE: asked one at a time, in the configured order, the next one
   * only when the one before had no quota, was unavailable or failed.
   */
  general: boolean;
  /**
   * The engine needs a key. The key is looked up at the moment of each search (the environment
   * variable named in the configuration, then the vault), so one added later is used right away.
   */
  key?: {
    /** The environment variable that holds the key when the configuration does not name another. */
    defaultEnv: string;
    /** The vault secret that holds the key when the configuration does not name another. */
    defaultSecret: string;
  };
  /** The terms of the service allow the answer to be kept in Suup's search cache. `false`: Brave. */
  cacheable: boolean;
  /**
   * The terms of the service forbid using the answers to evaluate or train AI. Such an engine is
   * never asked from `evals/` (the evaluation harness asks nothing general at all).
   */
  forbiddenInEvals: boolean;
  /**
   * The most searches Suup sends to this engine in a minute (the tool's own politeness, before the
   * search service is asked; `web.search.limits.perEngine` overrides it).
   */
  perMinute: number;
  /** The exact host names it connects to; `{lang}` is replaced by each language of `web.search.languages`. */
  hosts: readonly string[];
  /** One line for the docs and for `suup doctor`. */
  note: string;
}

export const ENGINES: readonly EngineSpec[] = [
  {
    id: "wikipedia",
    label: "Wikipédia",
    defaultOn: true,
    general: false,
    cacheable: true,
    forbiddenInEvals: false,
    perMinute: 30,
    hosts: ["{lang}.wikipedia.org"],
    note: "Wikipedia, searched with the MediaWiki Action API (list=search), one host per language, with the honest user agent.",
  },
  {
    id: "arxiv",
    label: "arXiv",
    defaultOn: true,
    general: false,
    cacheable: true,
    forbiddenInEvals: false,
    perMinute: 15,
    hosts: ["export.arxiv.org"],
    note: "arXiv API (Atom), scientific papers, at most one request every three seconds (arXiv terms of use), with the honest user agent.",
  },
  {
    id: "stackoverflow",
    label: "Stack Overflow",
    defaultOn: true,
    general: false,
    cacheable: true,
    forbiddenInEvals: false,
    perMinute: 10,
    hosts: ["api.stackexchange.com"],
    note: "Stack Exchange API 2.3 (Stack Overflow questions), honouring `backoff` and the quota, with the honest user agent.",
  },
  {
    id: "tavily",
    label: "Tavily",
    defaultOn: true,
    general: true,
    key: { defaultEnv: "TAVILY_API_KEY", defaultSecret: "TAVILY_API_KEY" },
    cacheable: true,
    forbiddenInEvals: false,
    perMinute: 30,
    hosts: ["api.tavily.com"],
    note: "General web search, Tavily Search API (POST /search, basic depth: 1 credit; 1000 credits a month on the free plan, no card). First in the queue.",
  },
  {
    id: "brave",
    label: "Brave Search",
    defaultOn: true,
    general: true,
    key: { defaultEnv: "BRAVE_SEARCH_API_KEY", defaultSecret: "BRAVE_SEARCH_API_KEY" },
    // Brave's terms: no storing or caching results beyond transient storage, and no use of results
    // to create, evaluate, train or benchmark AI (docs/pesquisas/fase-4-busca-alternativas-ao-ddg.md).
    cacheable: false,
    forbiddenInEvals: true,
    perMinute: 30,
    hosts: ["api.search.brave.com"],
    note: "General web search, Brave Search API (GET /res/v1/web/search). Second in the queue. Its results are never cached and never used in AI evaluations (Brave's terms).",
  },
];

export const DEFAULT_ENGINES: readonly string[] = ENGINES.filter((e) => e.defaultOn).map(
  (e) => e.id,
);
/** The general engines, in the order they are tried when the configuration says nothing. */
export const DEFAULT_GENERAL_ORDER: readonly string[] = ENGINES.filter((e) => e.general).map(
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

/** The exact host names the search egress proxy may reach for these engines and languages, sorted. */
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

/**
 * The general engines that are on, in the order they are tried: `order` (the configuration's, or
 * the default) first, restricted to the engines that are on, then any other general engine that is
 * on, in declaration order. Comparison by exact id.
 */
export function generalQueue(
  engines: readonly string[],
  order: readonly string[] = DEFAULT_GENERAL_ORDER,
): string[] {
  const on = engines.filter((id) => engineById(id)?.general === true);
  const queue = order.filter((id, i) => on.includes(id) && order.indexOf(id) === i);
  for (const id of on) if (!queue.includes(id)) queue.push(id);
  return queue;
}
