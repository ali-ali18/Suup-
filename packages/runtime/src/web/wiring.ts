// Owns binding the web (docs/BUSCA.md) to the runtime: what the configuration says, the services
// started at the first use, and the `WebAccess` every run's tools get. `@suup/web` (jsdom, the
// browser driver) is loaded only when something first needs it, so a program that never touches the
// web does not pay for it.
import type { WebAccess, WebPage, WebReadOutcome, WebSearchOutcome } from "@suup/core";
import type { StartedServices, WebAccessWithStatus, WebStatus } from "@suup/web";

export interface WebSettings {
  search?: {
    enabled?: boolean;
    engines?: string[];
    languages?: string[];
    url?: string;
    maxResults?: number;
    image?: string;
    network?: string;
    proxy?: { listenHost?: string; advertiseHost?: string; port?: number };
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
  close(): Promise<void>;
}

export function createWebWiring(
  settings: WebSettings | undefined,
  options: { dockerPath?: string; log?: (message: string) => void } = {},
): WebWiring {
  const searchEnabled = settings?.search?.enabled !== false;
  const readerEnabled = settings?.reader?.enabled !== false;
  let loaded: Promise<{ web: WebAccessWithStatus; stop(): Promise<void> }> | undefined;

  const load = () => {
    loaded ??= (async () => {
      const lib = await import("@suup/web");
      let started: Promise<StartedServices> | undefined;
      let stopServices: (() => Promise<void>) | undefined;
      const web = lib.createWebAccess({
        searchEnabled,
        readerEnabled,
        ...(settings?.search?.maxResults === undefined
          ? {}
          : { maxResults: settings.search.maxResults }),
        services: () => {
          started ??= lib
            .startWebServices({
              ...(options.dockerPath === undefined ? {} : { dockerPath: options.dockerPath }),
              ...(options.log === undefined ? {} : { log: options.log }),
              searchEnabled,
              readerEnabled,
              ...(settings?.search?.engines === undefined
                ? {}
                : { engines: settings.search.engines }),
              ...(settings?.search?.languages === undefined
                ? {}
                : { languages: settings.search.languages }),
              ...(settings?.search?.url === undefined ? {} : { searchUrl: settings.search.url }),
              ...(settings?.search?.image === undefined
                ? {}
                : { searxImage: settings.search.image }),
              ...(settings?.search?.network === undefined
                ? {}
                : { searchNetwork: settings.search.network }),
              ...(settings?.search?.proxy === undefined
                ? {}
                : { searchProxy: settings.search.proxy }),
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
    async close() {
      const current = loaded;
      loaded = undefined;
      if (current !== undefined) await (await current.catch(() => undefined))?.stop();
    },
  };
}
