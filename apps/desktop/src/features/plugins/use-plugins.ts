import type { CatalogItem, WebSearchSettings } from "@suup/api";
import { useCallback, useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { messageOf } from "../../data/sync.js";

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
    try {
      setItems(await api.connectorCatalog.list());
      setLoadError(undefined);
    } catch (e) {
      setLoadError(messageOf(e));
    }
    try {
      setSearch(await api.webSearch.get());
    } catch {
      // The engines are an extra: the connectors still show.
    }
  }, [api]);
  // `connectorsByName` is only the trigger: a connector of the store changed, read the gallery again.
  useEffect(() => {
    void reload();
  }, [reload, connectorsByName]);

  return { items, search, loadError, reload, connectorsByName };
}
