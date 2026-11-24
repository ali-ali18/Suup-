// Owns binding the web (docs/BUSCA.md) to the runtime: what the configuration says, the services
// started at the first use, and the `WebAccess` every run's tools get. `@suup/web` (jsdom, the
// browser driver) is loaded only when something first needs it, so a program that never touches the
// web does not pay for it.
import type { WebAccess, WebPage, WebReadOutcome, WebSearchOutcome } from "@suup/core";
import type {
  SearchCache,
  SearchKeys,
  SearchProviderStatus,
  SearchUsage,
  StartedServices,
  WebAccessWithStatus,
  WebStatus,
} from "@suup/web";

export interface WebSettings {
  search?: {
    enabled?: boolean;
    engines?: string[];
    languages?: string[];
    locale?: string;
    general?: { order?: string[] };
    maxResults?: number;
    limits?: { perMinute?: number; perEngine?: Record<string, number>; maxWaitSeconds?: number };
    cache?: { enabled?: boolean; ttlMinutes?: number };
  };
  reader?: { enabled?: boolean; render?: boolean; image?: string; repositoryUrl?: string };
}

export interface WebWiring {
  /** What the tools of every run get. Nothing starts until one of its methods is called. */
  readonly access: WebAccess;
  /**
   * What is configured and, once the services have started, what is running (for `suup doctor`).
   * It never starts them: the first tool that needs the web does, and a doctor that did would pull
   * images and start containers by being run.
   */
  status(): Promise<
    | (WebStatus & { started: true })
    | { started: false; search: "off" | "pending"; reader: "off" | "pending" }
  >;
  /**
   * From now on the engines whose terms forbid using their results to evaluate AI models (Brave's
   * do) are not asked: the evaluation harness (`evals/`) calls this before it runs anything. It
   * also drops the services already started, so the next search starts without them.
   */
  restrictForEvaluation(): Promise<void>;
  /**
   * The general search engines of the queue and where each stands (ready, no key, month's credits
   * used...), for Settings. Starts nothing, and never carries a key or a query.
   */
  searchProviders(): Promise<SearchProviderStatus[]>;
  close(): Promise<void>;
}

export function createWebWiring(
  settings: WebSettings | undefined,
  options: {
    dockerPath?: string;
    log?: (message: string) => void;
    /** Where cached searches live (the database in the runtime). Default: the memory of the process. */
    searchCache?: SearchCache;
    /** Where the keys of the general engines come from (environment, then vault). Default: no keys. */
    searchKeys?: SearchKeys;
    /** Where the searches each general engine answered are counted per month. Default: memory. */
    searchUsage?: SearchUsage;
  } = {},
): WebWiring {
  const searchEnabled = settings?.search?.enabled !== false;
  const readerEnabled = settings?.reader?.enabled !== false;
  let evaluation = false;
  let loaded: Promise<{ web: WebAccessWithStatus; stop(): Promise<void> }> | undefined;

  const load = () => {
    loaded ??= (async () => {
      const lib = await import("@suup/web");
      // Brave's terms forbid using its results to evaluate AI models: an evaluation never asks it.
      const engines = (settings?.search?.engines ?? lib.DEFAULT_ENGINES).filter(
        (id) => !evaluation || lib.engineById(id)?.forbiddenInEvals !== true,
      );
      let started: Promise<StartedServices> | undefined;
      let stopServices: (() => Promise<void>) | undefined;
      const web = lib.createWebAccess({
        searchEnabled,
        readerEnabled,
        engines,
        ...(settings?.search?.general?.order === undefined
          ? {}
          : { generalOrder: settings.search.general.order }),
        ...(settings?.search?.locale === undefined ? {} : { locale: settings.search.locale }),
        ...(options.searchKeys === undefined ? {} : { keys: options.searchKeys }),
        ...(options.searchUsage === undefined ? {} : { usage: options.searchUsage }),
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(settings?.search?.maxResults === undefined
          ? {}
          : { maxResults: settings.search.maxResults }),
        ...(settings?.search?.limits === undefined
          ? {}
          : {
              limits: {
                ...(settings.search.limits.perMinute === undefined
                  ? {}
                  : { perMinute: settings.search.limits.perMinute }),
                ...(settings.search.limits.perEngine === undefined
                  ? {}
                  : { perEngine: settings.search.limits.perEngine }),
                ...(settings.search.limits.maxWaitSeconds === undefined
                  ? {}
                  : { maxWaitMs: settings.search.limits.maxWaitSeconds * 1000 }),
              },
            }),
        ...(settings?.search?.cache?.enabled === undefined
          ? {}
          : { cacheEnabled: settings.search.cache.enabled }),
        ...(settings?.search?.cache?.ttlMinutes === undefined
          ? {}
          : { cacheTtlMs: settings.search.cache.ttlMinutes * 60_000 }),
        ...(options.searchCache === undefined ? {} : { cache: options.searchCache }),
        services: () => {
          started ??= lib
            .startWebServices({
              ...(options.dockerPath === undefined ? {} : { dockerPath: options.dockerPath }),
              ...(options.log === undefined ? {} : { log: options.log }),
              searchEnabled,
              readerEnabled,
              engines,
              ...(settings?.search?.languages === undefined
                ? {}
                : { languages: settings.search.languages }),
              ...(options.searchKeys === undefined ? {} : { keys: options.searchKeys }),
              ...(settings?.reader?.image === undefined
                ? {}
                : { readerImage: settings.reader.image }),
              ...(settings?.reader?.render === undefined ? {} : { render: settings.reader.render }),
              repositoryUrl: settings?.reader?.repositoryUrl ?? lib.REPOSITORY_URL,
            })
            .then((services) => {
              stopServices = () => services.stop();
              return services;
            });
          started.catch(() => {
            started = undefined; // try again at the next use
          });
          return started;
        },
      });
      return { web, stop: async () => stopServices?.() };
    })();
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };

  const access: WebAccess = {
    searchAvailable: searchEnabled,
    readerEnabled,
    renderAvailable: readerEnabled && settings?.reader?.render !== false,
    async search(request): Promise<WebSearchOutcome> {
      return await (await load()).web.search(request);
    },
    async read(request): Promise<WebReadOutcome> {
      return await (await load()).web.read(request);
    },
    async extract(input): Promise<WebPage | undefined> {
      return await (await load()).web.extract(input);
    },
  };
  return {
    access,
    async status() {
      if (loaded === undefined) {
        return {
          started: false as const,
          search: searchEnabled ? ("pending" as const) : ("off" as const),
          reader: readerEnabled ? ("pending" as const) : ("off" as const),
        };
      }
      return { started: true as const, ...(await (await loaded).web.status()) };
    },
    async searchProviders() {
      if (!searchEnabled) return [];
      return await (await load()).web.searchProviders();
    },
    async restrictForEvaluation() {
      evaluation = true;
      await this.close();
    },
    async close() {
      const current = loaded;
      loaded = undefined;
      if (current !== undefined) await (await current.catch(() => undefined))?.stop();
    },
  };
}
