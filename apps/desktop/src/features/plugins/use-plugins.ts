import type { CatalogItem, WebSearchSettings } from "@suup/api";
import { useCallback, useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { messageOf } from "../../data/sync.js";

/**
 * Whether the browser login of an OAuth entry can come back to the server: always with the server
 * on this computer; on a VPS only when it has its public address (`GET /v1/info`,
 * `oauthCallback`; docs/CONECTORES.md, "OAuth do MCP").
 */
export function useCanLogIn(): boolean {
  const { api, mode } = useServices();
  const [callback, setCallback] = useState<"loopback" | "public" | undefined>(undefined);
  useEffect(() => {
    if (mode === "local") return;
    api.info().then(
      (info) => setCallback(info.oauthCallback),
      () => setCallback(undefined),
    );
  }, [api, mode]);
  return mode === "local" || callback === "public";
}

/**
 * What the plugin screens read from the server: the gallery of connectors (`GET /v1/connector-catalog`)
 * and the web search engines (`GET /v1/web-search`), plus the connectors the app already holds. It
 * reads again when a connector of the store changes (turned on, removed, granted), so a row and a page
 * follow what the server holds. A search that fails to load is no reason to hide the connectors.
 */
export function usePlugins() {
  const { api } = useServices();
  const connectorsByName = useData((s) => s.connectors);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [search, setSearch] = useState<WebSearchSettings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    // Both are read together and set together, so a card never draws from half of the data.
    const [catalog, engines] = await Promise.allSettled([
      api.connectorCatalog.list(),
      api.webSearch.get(),
    ]);
    if (catalog.status === "fulfilled") {
      setItems(catalog.value);
      setLoadError(undefined);
    } else {
      setLoadError(messageOf(catalog.reason));
    }
    // The engines are an extra: the connectors still show when they do not load.
    if (engines.status === "fulfilled") setSearch(engines.value);
  }, [api]);
  // `connectorsByName` is only the trigger: a connector of the store changed, read the gallery again.
  useEffect(() => {
    void reload();
  }, [reload, connectorsByName]);

  return { items, search, loadError, reload, connectorsByName };
}
