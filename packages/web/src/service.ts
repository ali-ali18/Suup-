// Owns what the runtime hands the tools as `WebAccess`: search through the SearXNG container, and
// reading through the reader container, or in this process when there is no container. The
// containers are started the first time something needs them (`services`), so a run that never
// touches the web costs nothing. Choosing between them is a matter of what is available, never of
// what a page or a query says.
import type { WebAccess, WebReadOutcome, WebSearchOutcome } from "@suup/core";
import { createReader, type Reader } from "./reader.js";
import { createSearch, type SearxBackend } from "./search.js";
import type { StdioReaderClient } from "./stdio-client.js";

/** What starting the services produced (a subset of `WebServices`). */
export interface StartedServices {
  searchBackend?: SearxBackend | undefined;
  searchProblem?: string | undefined;
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
  maxResults?: number;
  /** The in-process reader used when there is no reader container. */
  local?: Reader;
}

export interface WebStatus {
  search: "ready" | "off" | "unavailable";
  searchProblem?: string;
  engines: readonly string[];
  reader: "container" | "local" | "off";
  readerProblem?: string;
  render: boolean;
}

export interface WebAccessWithStatus extends WebAccess {
  status(): Promise<WebStatus>;
}

export function createWebAccess(options: WebAccessOptions): WebAccessWithStatus {
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
      if (started.searchBackend === undefined) {
        return {
          ok: false,
          reason: "unavailable",
          message: `The search service is not running${started.searchProblem === undefined ? "" : ` (${started.searchProblem})`}.`,
        };
      }
      return await createSearch({
        backend: started.searchBackend,
        engines: started.engines,
        ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
      })(request);
    },
    async read(request): Promise<WebReadOutcome> {
      if (!options.readerEnabled) {
        return { ok: false, reason: "unavailable", message: "The reader service is turned off." };
      }
      const started = await options.services();
      if (started.reader !== undefined) {
        const outcome = await started.reader.read(request);
        renderKnown = started.reader.renderAvailable === true;
        return outcome;
      }
      // No container: read in this process (no rendering).
      return await localReader().read(request);
    },
    extract: async (input) => localReader().extract(input),
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
          : started.searchBackend === undefined
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
