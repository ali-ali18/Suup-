// Owns what the runtime hands the tools as `WebAccess`: search through the SearXNG container, and
// reading through the reader container, or in this process when there is no container. Choosing
// between them is a matter of what is available, never of what a page or a query says.
import type { WebAccess, WebReadOutcome, WebSearchOutcome } from "@suup/core";
import { createReader, type Reader } from "./reader.js";
import { createSearch, type SearxBackend } from "./search.js";
import type { StdioReaderClient } from "./stdio-client.js";

export interface WebAccessOptions {
  searchBackend?: SearxBackend;
  engines?: readonly string[];
  maxResults?: number;
  /** The reader service is on (the owner's setting). `false`: `read` says it is off and the tool uses the bot's machine. */
  readerEnabled: boolean;
  /** The reader container. Without it, the reader runs in this process (no rendering). */
  container?: StdioReaderClient;
  /** For tests: the in-process reader. */
  local?: Reader;
  unavailableSearch?: string;
}

export function createWebAccess(options: WebAccessOptions): WebAccess {
  const search =
    options.searchBackend === undefined
      ? undefined
      : createSearch({
          backend: options.searchBackend,
          engines: options.engines ?? [],
          ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
        });
  const local =
    options.container === undefined && options.readerEnabled
      ? (options.local ?? createReader())
      : undefined;
  // The in-process reader also does the HTML to Markdown for pages the bot's machine downloaded.
  const converter = options.local ?? local ?? createReader();
  return {
    searchAvailable: search !== undefined,
    readerEnabled: options.readerEnabled,
    get renderAvailable() {
      return options.readerEnabled && options.container?.renderAvailable === true;
    },
    async search(request): Promise<WebSearchOutcome> {
      if (search === undefined) {
        return {
          ok: false,
          reason: "unavailable",
          message:
            options.unavailableSearch ??
            "Web search is not available here (the search service is not running).",
        };
      }
      return await search(request);
    },
    async read(request): Promise<WebReadOutcome> {
      if (!options.readerEnabled) {
        return { ok: false, reason: "unavailable", message: "The reader service is turned off." };
      }
      if (options.container !== undefined) return await options.container.read(request);
      return await (local as Reader).read(request);
    },
    extract: (input) => converter.extract(input),
  };
}
