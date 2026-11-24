// Owns what the runtime hands the tools as `WebAccess`: search through the engines' official APIs
// (the specialised ones together, the general ones as a queue with failover), and reading through
// the reader container, or in this process when there is no container. What they need is started
// the first time something needs it (`services`), so a run that never touches the web costs
// nothing. Choosing between them is a matter of what is available, never of what a page or a query
// says.
import type { WebAccess, WebReadOutcome, WebSearchOutcome } from "@suup/core";
import type { DirectEngine } from "./direct-engines.js";
import { DEFAULT_ENGINES, DEFAULT_GENERAL_ORDER, engineById, generalQueue } from "./engines.js";
import type { SearchKeys } from "./general-engines.js";
import { createReader, type Reader } from "./reader.js";
import { createSearch } from "./search.js";
import { memorySearchCache, type SearchCache } from "./search-cache.js";
import { SearchGovernor, type SearchLimits } from "./search-governor.js";
import { memorySearchUsage, type SearchUsage } from "./search-usage.js";
import type { StdioReaderClient } from "./stdio-client.js";

/** What starting the services produced (a subset of `WebServices`). */
export interface StartedServices {
  searchProblem?: string | undefined;
  /** The engines Suup asks, by official API. */
  direct?: readonly DirectEngine[] | undefined;
  engines: readonly string[];
  reader?: StdioReaderClient | undefined;
  readerProblem?: string | undefined;
}

export interface WebAccessOptions {
  /** The search service is wanted (the owner's setting). */
  searchEnabled: boolean;
  /** The reader service is wanted. `false`: the tool reads with the bot's machine instead. */
  readerEnabled: boolean;
  /** Starts the services (called once, at the first use; the caller memoizes it). */
  services(): Promise<StartedServices>;
  /** The engines that are turned on (the configuration's list). Default: the default list. */
  engines?: readonly string[];
  /** The order the general engines are tried in. Default: the order they are declared in. */
  generalOrder?: readonly string[];
  /** The person's locale (`pt-BR`): the general engines rank for its country and language. */
  locale?: string;
  /** Where the general engines find their keys (to say, in the status, which have one). */
  keys?: SearchKeys;
  /** Where the searches each general engine answered are counted, per month. Default: memory. */
  usage?: SearchUsage;
  maxResults?: number;
  /** Suup's own limits on searches (docs/BUSCA.md, "Busca educada"). */
  limits?: Partial<SearchLimits>;
  /** Where cached searches live. Default: the memory of this process. */
  cache?: SearchCache;
  /** `false`: no cache at all. Default `true`. */
  cacheEnabled?: boolean;
  /** How long a cached search lives. Default 3 hours. */
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The in-process reader used when there is no reader container. */
  local?: Reader;
  /**
   * Where a read that could not reach a site, or a search that failed, is told, with what failed
   * (the logs; never the model nor the user): `web_read: could not reach <host> (robots, container):
   * stage=dns code=EAI_AGAIN ...`, `web_search: unavailable: ...`.
   */
  log?: (message: string) => void;
}

/**
 * One line for the logs about a search that failed or where engines did not answer
 * (docs/USAR-NO-WINDOWS.md, 4b). Never the query: it can carry what the user is looking for. A
 * failover between general engines is logged by the search itself (`failoverLogLine`).
 */
export function searchProblemLogLine(outcome: WebSearchOutcome): string | undefined {
  if (!outcome.ok) {
    const retry =
      outcome.retryInSeconds === undefined ? "" : ` retry_in=${outcome.retryInSeconds}s`;
    return `web_search: ${outcome.reason}: ${outcome.message}${retry}`;
  }
  const parts: string[] = [];
  for (const s of outcome.suspended) {
    parts.push(
      `${s.engine} did not answer (${s.reason}${s.retryInSeconds === undefined ? "" : `, retry_in=${s.retryInSeconds}s`})`,
    );
  }
  for (const t of outcome.throttled ?? []) {
    parts.push(`${t.engine} left out by Suup's limit (retry_in=${t.retryInSeconds}s)`);
  }
  if (outcome.generalUnavailable !== undefined) {
    parts.push(
      `no general web engine available (${outcome.generalUnavailable.cause ?? "unknown"})`,
    );
  }
  if (parts.length === 0) return undefined;
  return `web_search: ${outcome.hits.length} results; ${parts.join("; ")}`;
}

/** One line for the logs about a read that could not reach the site (docs/USAR-NO-WINDOWS.md, 4b). */
export function readFailureLogLine(
  outcome: WebReadOutcome,
  where: "container" | "local",
): string | undefined {
  if (outcome.ok || outcome.diagnostic === undefined) return undefined;
  const d = outcome.diagnostic;
  const parts = [
    `stage=${d.stage}`,
    ...(d.code === undefined ? [] : [`code=${d.code}`]),
    ...(d.addresses === undefined || d.addresses.length === 0
      ? []
      : [`addresses=${d.addresses.join(",")}`]),
    ...(d.detail === undefined ? [] : [`detail=${JSON.stringify(d.detail.slice(0, 300))}`]),
  ];
  return `web_read: could not reach ${d.host} (${d.request ?? "page"}, reader ${where}, reason ${outcome.reason}): ${parts.join(" ")}`;
}

export interface WebStatus {
  search: "ready" | "off" | "unavailable";
  searchProblem?: string;
  engines: readonly string[];
  reader: "container" | "local" | "off";
  readerProblem?: string;
  render: boolean;
}

/** What a general engine can be, in the words of the app: ready, no key, month's credits used, key not accepted, not answering, or turned off. */
export type ProviderState = "ready" | "no_key" | "quota" | "key_rejected" | "unavailable" | "off";

/** One general engine of the queue, as Settings shows it. Never a key, never a query. */
export interface SearchProviderStatus {
  id: string;
  /** The name the person sees. */
  label: string;
  /** 1 is tried first. Engines that are off come last. */
  position: number;
  state: ProviderState;
  /** For `quota`, `key_rejected` and `unavailable`: when Suup tries it again, in seconds (when known). */
  retryInSeconds?: number;
  /** Searches this engine answered this calendar month (UTC). */
  searchesThisMonth: number;
  /** The names a key is found under: the vault secret the app writes, and the environment variable. */
  keyNames?: { secret: string; env: string };
}

export interface WebAccessWithStatus extends WebAccess {
  status(): Promise<WebStatus>;
  /** The general engines of the queue and where each stands. Starts nothing. */
  searchProviders(): Promise<SearchProviderStatus[]>;
}

export function createWebAccess(options: WebAccessOptions): WebAccessWithStatus {
  // One governor and one cache for the life of the process: the limits only mean something if every
  // search goes through the same ones.
  const governor = new SearchGovernor({
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const cache = options.cacheEnabled === false ? undefined : (options.cache ?? memorySearchCache());
  const usage = options.usage ?? memorySearchUsage();
  const configured = options.engines ?? DEFAULT_ENGINES;
  let local: Reader | undefined = options.local;
  const localReader = (): Reader => {
    local ??= createReader();
    return local;
  };
  let renderKnown = false;
  return {
    searchAvailable: options.searchEnabled,
    readerEnabled: options.readerEnabled,
    get renderAvailable() {
      return renderKnown;
    },
    async search(request): Promise<WebSearchOutcome> {
      if (!options.searchEnabled) {
        return {
          ok: false,
          reason: "unavailable",
          message: "Web search is turned off in the configuration.",
        };
      }
      const started = await options.services();
      if ((started.direct ?? []).length === 0) {
        const outcome: WebSearchOutcome = {
          ok: false,
          reason: "unavailable",
          message: `The search engines could not be started${started.searchProblem === undefined ? "" : ` (${started.searchProblem})`}.`,
        };
        options.log?.(searchProblemLogLine(outcome) ?? "");
        return outcome;
      }
      const outcome = await createSearch({
        direct: started.direct ?? [],
        engines: started.engines,
        ...(options.generalOrder === undefined ? {} : { generalOrder: options.generalOrder }),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
        usage,
        ...(options.log === undefined ? {} : { log: options.log }),
        governor,
        ...(cache === undefined ? {} : { cache }),
        ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
      })(request);
      const line = searchProblemLogLine(outcome);
      if (line !== undefined) options.log?.(line);
      return outcome;
    },
    async read(request): Promise<WebReadOutcome> {
      if (!options.readerEnabled) {
        return { ok: false, reason: "unavailable", message: "The reader service is turned off." };
      }
      const started = await options.services();
      const logged = (outcome: WebReadOutcome, where: "container" | "local"): WebReadOutcome => {
        const line = readFailureLogLine(outcome, where);
        if (line !== undefined) options.log?.(line);
        return outcome;
      };
      if (started.reader !== undefined) {
        const outcome = await started.reader.read(request);
        renderKnown = started.reader.renderAvailable === true;
        return logged(outcome, "container");
      }
      // No container: read in this process (no rendering), and say why a render cannot happen.
      if (request.render === true && started.readerProblem !== undefined) {
        return {
          ok: false,
          reason: "unavailable",
          message: `Rendering pages with JavaScript needs the reader container, which is not running here (${started.readerProblem}). Read without render, or tell the user.`,
        };
      }
      return logged(await localReader().read(request), "local");
    },
    extract: async (input) => localReader().extract(input),
    async searchProviders(): Promise<SearchProviderStatus[]> {
      const queue = generalQueue(configured, options.generalOrder);
      const everyone = generalQueue(DEFAULT_GENERAL_ORDER, options.generalOrder);
      const month = await usage.month(new Date((options.now ?? Date.now)())).catch(() => ({}));
      const suspended = governor.suspended();
      const out: SearchProviderStatus[] = [];
      const ordered = [...queue, ...everyone.filter((id) => !queue.includes(id))];
      for (const [index, id] of ordered.entries()) {
        const spec = engineById(id);
        if (spec === undefined) continue;
        const on = queue.includes(id);
        const hasKey = (await options.keys?.get(id).catch(() => undefined)) !== undefined;
        const wait = suspended.get(id);
        const state: ProviderState = !on
          ? "off"
          : !hasKey
            ? "no_key"
            : wait === undefined
              ? "ready"
              : wait.kind === "quota"
                ? "quota"
                : wait.kind === "key_rejected"
                  ? "key_rejected"
                  : "unavailable";
        out.push({
          id,
          label: spec.label,
          position: index + 1,
          state,
          ...(wait === undefined || state === "off" || state === "no_key"
            ? {}
            : { retryInSeconds: wait.retryInSeconds }),
          searchesThisMonth: (month as Record<string, number>)[id] ?? 0,
          ...(spec.key === undefined
            ? {}
            : {
                keyNames: options.keys?.names?.(id) ?? {
                  secret: spec.key.defaultSecret,
                  env: spec.key.defaultEnv,
                },
              }),
        });
      }
      return out;
    },
    async status(): Promise<WebStatus> {
      const started = await options.services();
      const reader = !options.readerEnabled
        ? "off"
        : started.reader !== undefined
          ? "container"
          : "local";
      return {
        search: !options.searchEnabled
          ? "off"
          : (started.direct ?? []).length === 0
            ? "unavailable"
            : "ready",
        ...(started.searchProblem === undefined ? {} : { searchProblem: started.searchProblem }),
        engines: started.engines,
        reader,
        ...(started.readerProblem === undefined ? {} : { readerProblem: started.readerProblem }),
        render: started.reader?.renderAvailable === true,
      };
    },
  };
}
