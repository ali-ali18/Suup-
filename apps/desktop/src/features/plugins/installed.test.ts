import type { CatalogItem, SearchProvider, WebSearchSettings } from "@suup/api";
import { catalogEntrySchema } from "@suup/api";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  type CatalogEntry as ServerEntry,
} from "../../../../../packages/connectors/src/catalog.js";
import { makeConnector, makeConnectorTool } from "../../test-fixtures.js";
import { installedPlugins, queueWords, usageWords } from "./installed.js";

function entry(id: string) {
  const e = CONNECTOR_CATALOG.find((c) => c.id === id) as ServerEntry;
  const auth =
    e.auth.kind === "oauth"
      ? { kind: "oauth" as const, scopes: null }
      : e.auth.kind === "token"
        ? { ...e.auth, prefix: e.auth.prefix ?? null, steps: [...e.auth.steps] }
        : { ...e.auth, steps: [...e.auth.steps] };
  return catalogEntrySchema.parse({
    ...JSON.parse(JSON.stringify(e)),
    auth,
    unverifiedReason: e.unverifiedReason ?? null,
    disclosure: e.disclosure ?? null,
    authHosts: [...(e.authHosts ?? [])],
    authLinkSegment: e.authLinkSegment ?? null,
    deniedTools: [...(e.deniedTools ?? [])],
  });
}
const item = (id: string, status: CatalogItem["status"], connector: string | null = id) =>
  ({ entry: entry(id), status, connector, detail: null, login: null }) as CatalogItem;

const provider = (over: Partial<SearchProvider> & { id: string }): SearchProvider => ({
  label: over.id === "tavily" ? "Tavily" : "Brave Search",
  position: 1,
  state: "ready",
  searchesThisMonth: 3,
  plugin: {
    id: over.id,
    category: "Pesquisa na web",
    description: "d",
    notes: [],
    keySteps: ["a"],
  },
  ...over,
});

describe("the installed list", () => {
  it("shows only what is installed, with the catalog's friendly name, never the connector's", () => {
    const list = installedPlugins({
      catalog: [item("github", "available", null), item("notion", "connected")],
      search: undefined,
      connectors: [makeConnector({ name: "notion" })],
    });
    expect(list.map((p) => [p.kind, p.id, p.name])).toEqual([["catalog", "notion", "Notion"]]);
    expect(list[0]?.verified).toBe(true);
    expect(list[0]?.look.tone).toBe("white");
    expect(list[0]?.look.logo).toBeDefined();
  });

  it("says the status in words: Conectado (green), Conectar (a pill) for a login or a key, Desligado, Não conectou", () => {
    const status = (s: CatalogItem["status"]) =>
      installedPlugins({ catalog: [item("notion", s)], search: undefined, connectors: [] })[0]
        ?.status;
    expect(status("connected")).toEqual({ tone: "ok", label: "Conectado" });
    expect(status("needs_login")).toEqual({ tone: "action", label: "Conectar" });
    expect(status("needs_secret")).toEqual({ tone: "action", label: "Conectar" });
    expect(status("off")).toEqual({ tone: "muted", label: "Desligado" });
    expect(status("error")).toEqual({ tone: "muted", label: "Não conectou" });
  });

  it("the muted line is plain words from declared data: tools and bots", () => {
    const tools = [makeConnectorTool({ tool: "a" }), makeConnectorTool({ tool: "b" })];
    const line = (connector: ReturnType<typeof makeConnector>) =>
      installedPlugins({
        catalog: [item("notion", "connected")],
        search: undefined,
        connectors: [connector],
      })[0]?.line;
    expect(line(makeConnector({ name: "notion", tools: null }))).toBe(
      "Ferramentas ainda não listadas · nenhum bot",
    );
    expect(
      line(
        makeConnector({
          name: "notion",
          tools,
          grants: [{ botId: "x", all: true, tools: [] }],
        }),
      ),
    ).toBe("2 ferramentas · 1 bot");
  });

  it("a connector added by hand still shows, with the generic icon and its own name", () => {
    const list = installedPlugins({
      catalog: [item("notion", "connected")],
      search: undefined,
      connectors: [makeConnector({ name: "notion" }), makeConnector({ name: "meu-servidor" })],
    });
    const manual = list.find((p) => p.kind === "manual");
    expect(manual).toMatchObject({
      id: "meu-servidor",
      name: "meu-servidor",
      verified: false,
      look: { tone: "neutral", glyph: "plug" },
      status: { tone: "ok", label: "Conectado" },
    });
    expect(manual?.look.logo).toBeUndefined();
    // off, and with an error
    const off = installedPlugins({
      catalog: [],
      search: undefined,
      connectors: [makeConnector({ name: "x", enabled: false })],
    })[0];
    expect(off?.status.label).toBe("Desligado");
    const bad = installedPlugins({
      catalog: [],
      search: undefined,
      connectors: [
        makeConnector({
          name: "y",
          discovery: { discoveredAt: null, lastError: "boom", lastErrorAt: null },
        }),
      ],
    })[0];
    expect(bad?.status.label).toBe("Não conectou");
  });

  it("the search engines appear once a key is set (not before), in the queue's order, never as connectors", () => {
    const search: WebSearchSettings = {
      enabled: true,
      providers: [
        provider({ id: "tavily", state: "no_key", position: 1 }),
        provider({ id: "brave", state: "quota", position: 2, searchesThisMonth: 1 }),
      ],
    };
    const list = installedPlugins({ catalog: [], search, connectors: [] });
    expect(list.map((p) => [p.kind, p.id, p.name, p.status.label, p.line])).toEqual([
      [
        "search",
        "brave",
        "Brave Search",
        "Cota do mês usada",
        "Pesquisa na web · 1 busca este mês",
      ],
    ]);
    const ready = installedPlugins({
      catalog: [],
      search: { enabled: true, providers: [provider({ id: "tavily" })] },
      connectors: [],
    });
    expect(ready[0]?.status).toEqual({ tone: "ok", label: "Pronto" });
    // search off: nothing
    expect(
      installedPlugins({ catalog: [], search: { enabled: false, providers: [] }, connectors: [] }),
    ).toEqual([]);
  });

  it("counts and queue in words", () => {
    expect(usageWords(0)).toBe("0 buscas este mês");
    expect(usageWords(1)).toBe("1 busca este mês");
    expect(queueWords(provider({ id: "tavily" }))).toContain("1º da fila");
    expect(queueWords(provider({ id: "brave", position: 2 }))).toContain("2º da fila");
  });
});
