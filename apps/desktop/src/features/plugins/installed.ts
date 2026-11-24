import type {
  CatalogItem,
  Connector,
  SearchPlugin,
  SearchProvider,
  WebSearchSettings,
} from "@suup/api";
import { appearanceOf, type Tone } from "./appearance.js";

// The "Instalado" list (Configurações > Conectores) and the search plugins of the gallery, as plain
// data (docs/DESIGN.md §3c, "Conectores: Instalado"). Everything is DECLARED data, never read from a
// text (docs/REGRAS.md §1): the name and the entry come from the server's gallery, the status from
// the server's status, and the search engines from `GET /v1/web-search`. A connector the person added
// by hand is not in the gallery: it keeps its own name and the generic icon.

/** How an installed plugin stands, for the right end of its row. */
export interface PluginStatus {
  /** `ok`: green words; `action`: the "Conectar" pill; `muted`: quiet words. */
  tone: "ok" | "action" | "muted";
  label: string;
}

/** What the tile of an entry draws. */
export interface PluginLook {
  tone: Tone;
  /** The service's own logo (an SVG of `assets/brand/`), if the app has it. */
  logo?: string | undefined;
  /** What is drawn when there is no logo: the plug, or a magnifier for a search engine. */
  glyph: "plug" | "search";
}

export interface InstalledPlugin {
  kind: "catalog" | "search" | "manual";
  /** The gallery id, the engine id, or the connector's name (`manual`). */
  id: string;
  /** The name people know it by: "Notion", never "notion" (the gallery's, or the connector's own). */
  name: string;
  /** One muted line in plain words. */
  line: string;
  status: PluginStatus;
  look: PluginLook;
  /** It comes from our catalog (the small verified mark). */
  verified: boolean;
}

/** How each state of a search engine is said (docs/DESIGN.md, "Amigável": plain words, never a code). */
export const PROVIDER_STATE_WORDS: Readonly<Record<SearchProvider["state"], string>> = {
  ready: "Pronto",
  no_key: "Sem chave",
  quota: "Cota do mês usada",
  key_rejected: "Chave não aceita",
  unavailable: "Não respondeu agora",
  off: "Desligado",
};

/** "1 busca este mês", "12 buscas este mês". */
export function usageWords(count: number): string {
  return count === 1 ? "1 busca este mês" : `${count} buscas este mês`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The tools and the bots of a connector, in plain words (nothing technical, nothing guessed). */
export function connectorLine(connector: Connector | undefined): string {
  if (connector === undefined) return "Ainda não instalado";
  const offered = (connector.tools ?? []).filter((t) => t.available).length;
  const withAccess = connector.grants.filter((g) => g.all || g.tools.length > 0).length;
  return [
    connector.tools === null
      ? "Ferramentas ainda não listadas"
      : plural(offered, "ferramenta", "ferramentas"),
    withAccess === 0 ? "nenhum bot" : plural(withAccess, "bot", "bots"),
  ].join(" · ");
}

/** The status of an entry of the gallery that is installed. */
export function catalogStatus(item: CatalogItem): PluginStatus {
  switch (item.status) {
    case "connected":
      return { tone: "ok", label: "Conectado" };
    case "needs_login":
    case "needs_secret":
      return { tone: "action", label: "Conectar" };
    case "error":
      return { tone: "muted", label: "Não conectou" };
    default:
      return { tone: "muted", label: "Desligado" };
  }
}

/** The status of a connector the person added by hand. */
export function manualStatus(connector: Connector): PluginStatus {
  if (!connector.enabled) return { tone: "muted", label: "Desligado" };
  return connector.discovery.lastError !== null
    ? { tone: "muted", label: "Não conectou" }
    : { tone: "ok", label: "Conectado" };
}

/** Whether an engine has its key (so it is installed): the key is the install. */
export function searchInstalled(provider: SearchProvider): boolean {
  return provider.state !== "no_key" && provider.state !== "off";
}

export function searchStatus(provider: SearchProvider): PluginStatus {
  return provider.state === "ready"
    ? { tone: "ok", label: PROVIDER_STATE_WORDS.ready }
    : { tone: "muted", label: PROVIDER_STATE_WORDS[provider.state] };
}

/** How the tile of a search engine is drawn: its own look by exact id (Brave's colour, Tavily's logo). */
export function searchLook(provider: Pick<SearchProvider, "id">): PluginLook {
  const look = appearanceOf(provider.id);
  return { tone: look.tone, logo: look.logo, glyph: "search" };
}

/** The engines the gallery offers as plugins (those with a gallery entry), in the queue's order. */
export function searchPlugins(
  settings: WebSearchSettings | undefined,
): { provider: SearchProvider; plugin: SearchPlugin }[] {
  if (settings === undefined || !settings.enabled) return [];
  return settings.providers.flatMap((provider) =>
    provider.plugin === null ? [] : [{ provider, plugin: provider.plugin }],
  );
}

/** The sentence about where an engine is in the queue ("1º da fila"). */
export function queueWords(provider: SearchProvider): string {
  return provider.position === 1
    ? "1º da fila: é o primeiro que a busca tenta"
    : `${provider.position}º da fila: entra quando o anterior não responde`;
}

/**
 * The installed plugins, in the order the person sees them: the gallery's entries that have a
 * connector (the server's order), the search engines that have a key (the queue's order), then the
 * connectors added by hand (by name). `connectors` is the app's list of connectors by name.
 */
export function installedPlugins(input: {
  catalog: readonly CatalogItem[];
  search: WebSearchSettings | undefined;
  connectors: readonly Connector[];
}): InstalledPlugin[] {
  const byName = new Map(input.connectors.map((c) => [c.name, c]));
  const inCatalog = new Set<string>();
  const out: InstalledPlugin[] = [];
  for (const item of input.catalog) {
    if (item.connector === null) continue;
    inCatalog.add(item.connector);
    const look = appearanceOf(item.entry.id);
    out.push({
      kind: "catalog",
      id: item.entry.id,
      name: item.entry.name,
      line: connectorLine(byName.get(item.connector)),
      status: catalogStatus(item),
      look: { tone: look.tone, logo: look.logo, glyph: "plug" },
      verified: true,
    });
  }
  for (const { provider, plugin } of searchPlugins(input.search)) {
    if (!searchInstalled(provider)) continue;
    out.push({
      kind: "search",
      id: plugin.id,
      name: provider.label,
      line: `Pesquisa na web · ${usageWords(provider.searchesThisMonth)}`,
      status: searchStatus(provider),
      look: searchLook(provider),
      verified: true,
    });
  }
  for (const connector of input.connectors) {
    if (inCatalog.has(connector.name)) continue;
    // One that came from the gallery but is not in this list yet (the gallery did not load): the
    // generic look and its own name until it does.
    out.push({
      kind: "manual",
      id: connector.name,
      name: connector.name,
      line: connectorLine(connector),
      status: manualStatus(connector),
      look: { tone: "neutral", glyph: "plug" },
      verified: false,
    });
  }
  return out;
}
