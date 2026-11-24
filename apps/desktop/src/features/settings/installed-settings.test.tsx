import { type CatalogItem, catalogEntrySchema, type SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_CATALOG } from "../../../../../packages/connectors/src/catalog.js";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { setConnectors } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeConnector } from "../../test-fixtures.js";
import { Modal } from "../../ui/dialog.js";
import { ConnectorsSettings } from "./ConnectorsSettings.js";

afterEach(cleanup);

const notion = (() => {
  const e = CONNECTOR_CATALOG.find((c) => c.id === "notion");
  if (e === undefined) throw new Error("no notion");
  return catalogEntrySchema.parse({
    ...JSON.parse(JSON.stringify(e)),
    auth: { kind: "oauth", scopes: null },
    unverifiedReason: null,
    disclosure: null,
    authHosts: [],
    authLinkSegment: null,
    deniedTools: [],
  });
})();
const item = (status: CatalogItem["status"]): CatalogItem => ({
  entry: notion,
  status,
  connector: status === "available" ? null : "notion",
  detail: null,
  login: null,
});

function setup(status: CatalogItem["status"], extra = [makeConnector({ name: "meu-servidor" })]) {
  const connectors = [
    ...(status === "available" ? [] : [makeConnector({ name: "notion" })]),
    ...extra,
  ];
  const api = {
    connectorCatalog: { list: vi.fn(async () => [item(status)]) },
    webSearch: {
      get: vi.fn(async () => ({
        enabled: true,
        providers: [
          {
            id: "tavily",
            label: "Tavily",
            position: 1,
            state: "ready",
            searchesThisMonth: 4,
            plugin: {
              id: "tavily",
              category: "Pesquisa na web",
              description: "d",
              notes: [],
              keySteps: [],
            },
          },
        ],
      })),
    },
    connectors: { list: vi.fn(async () => connectors) },
    vault: { list: vi.fn(async () => []) },
  };
  const store = createDataStore();
  update(store, (s) => setConnectors(s, connectors));
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  render(
    <ServicesProvider services={{ api, sync, data: store } as unknown as Services}>
      <Modal onClose={() => {}} label="Configurações" className="">
        <ConnectorsSettings title="Conectores" titleId="t" />
      </Modal>
    </ServicesProvider>,
  );
}

describe("Configurações > Conectores is the installed list", () => {
  it("shows only what is installed: the friendly name, a plain line and the state; a manual connector with its own name", async () => {
    setup("connected");
    await waitFor(() => expect(screen.getAllByTestId("installed-item")).toHaveLength(3));
    const rows = screen.getAllByTestId("installed-item");
    expect(rows.map((r) => r.getAttribute("data-plugin"))).toEqual([
      "notion",
      "tavily",
      "meu-servidor",
    ]);
    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain("Notion");
    expect(first.textContent).not.toContain("notion");
    expect(within(first).getByTestId("installed-state").textContent).toBe("Conectado");
    expect(within(first).getByTestId("installed-state").getAttribute("data-tone")).toBe("ok");
    expect(rows[1]?.textContent).toContain("Pesquisa na web · 4 buscas este mês");
    expect(rows[2]?.textContent).toContain("meu-servidor");
    // nothing is managed here any more
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Abrir")).toBeNull();
    expect(screen.queryByTestId("connector-details")).toBeNull();
  });

  it("a plugin that needs a login has the 'Conectar' pill, which opens its page and starts", async () => {
    setup("needs_login", []);
    const row = (await screen.findAllByTestId("installed-item"))[0] as HTMLElement;
    fireEvent.click(within(row).getByTestId("installed-connect"));
    expect(useUi.getState()).toMatchObject({
      view: "connectors",
      settingsOpen: false,
      plugin: { kind: "catalog", id: "notion", autoStart: true },
    });
  });

  it("clicking a row opens ITS page; 'Mostrar todos' opens the gallery; nothing installed says so", async () => {
    setup("connected", []);
    const row = (await screen.findAllByTestId("installed-item"))[0] as HTMLElement;
    fireEvent.click(row.querySelector("button") as HTMLElement);
    expect(useUi.getState().plugin).toMatchObject({
      kind: "catalog",
      id: "notion",
      autoStart: false,
    });
    fireEvent.click(screen.getByTestId("installed-show-all"));
    expect(useUi.getState().plugin).toBeNull();
    expect(screen.getByTestId("installed-show-all").textContent).toBe("Mostrar todos os 2 plugins");
    cleanup();
    setup("available", []);
    await waitFor(() => expect(screen.queryAllByTestId("installed-item")).toHaveLength(1));
  });
});
