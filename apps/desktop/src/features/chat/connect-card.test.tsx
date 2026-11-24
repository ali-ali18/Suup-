import { type CatalogItem, catalogEntrySchema, type SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_CATALOG } from "../../../../../packages/connectors/src/catalog.js";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import type { ConnectCardItem } from "../../data/connect-cards.js";
import { setConnectors } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeConnector } from "../../test-fixtures.js";
import { ConnectCard } from "./ConnectCard.js";

afterEach(cleanup);

const composio = (() => {
  const e = CONNECTOR_CATALOG.find((c) => c.id === "composio");
  if (e === undefined || e.auth.kind !== "token") throw new Error("no composio");
  return catalogEntrySchema.parse({
    ...JSON.parse(JSON.stringify(e)),
    auth: { ...e.auth, prefix: e.auth.prefix ?? null, steps: [...e.auth.steps] },
    unverifiedReason: null,
    disclosure: e.disclosure ?? null,
    authHosts: [...(e.authHosts ?? [])],
    authLinkSegment: e.authLinkSegment ?? null,
    deniedTools: [...(e.deniedTools ?? [])],
  });
})();

const BOT = "00000000-0000-4000-8000-0000000000b1";
const card = (over: Partial<ConnectCardItem> = {}): ConnectCardItem => ({
  callId: "c1",
  runId: "r1",
  botId: BOT,
  at: "2026-11-24T12:00:00.000Z",
  connector: "composio",
  action: "connect",
  ...over,
});
const item = (status: CatalogItem["status"]): CatalogItem => ({
  entry: composio,
  status,
  connector: "composio",
  detail: null,
  login: null,
});

function setup(status: CatalogItem["status"], granted: boolean, theCard: ConnectCardItem) {
  const connector = makeConnector({
    name: "composio",
    transport: { kind: "http", url: "https://connect.composio.dev/mcp" },
    grants: granted ? [{ botId: BOT, all: true, tools: [] }] : [],
  });
  const openUrl = vi.fn();
  const api = {
    connectorCatalog: { list: vi.fn(async () => [item(status)]), install: vi.fn() },
    webSearch: { get: vi.fn(async () => ({ enabled: true, providers: [] })) },
    connectors: {
      list: vi.fn(async () => [connector]),
      grant: vi.fn(async () => connector),
      update: vi.fn(async () => connector),
    },
  };
  const store = createDataStore();
  update(store, (s) => setConnectors(s, [connector]));
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = {
    api,
    sync,
    data: store,
    platform: { openUrl },
    mode: "local",
  } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ConnectCard card={theCard} botName="Nova" />
    </ServicesProvider>,
  );
  return { api, openUrl };
}

const primary = () => screen.findByTestId("connect-card-primary");

describe("the connector card in the chat", () => {
  it("an authorization link is a BUTTON: 'Conectar Google Agenda' opens it in the system browser, and the address never shows", async () => {
    const url = "https://connect.composio.dev/link/lk_abc?secret=zzz";
    const t = setup(
      "connected",
      true,
      card({ action: "authorize_app", app: "Google Agenda", url }),
    );
    const button = await primary();
    expect(button.textContent).toBe("Conectar Google Agenda");
    expect(screen.getByTestId("connect-card-status").textContent).toBe("Falta autorizar");
    fireEvent.click(button);
    expect(t.openUrl).toHaveBeenCalledWith(url);
    expect(document.body.textContent).not.toContain("secret=zzz");
    expect(document.body.textContent).not.toContain("connect.composio.dev");
    expect(screen.getByTestId("connect-card-after").textContent).toBe(
      "Depois de autorizar, me avise.",
    );
    // the brand name with the verified mark, and the calm line under the card
    expect(screen.getByTestId("connect-card-note").textContent).toBe(
      "O Nova sempre pergunta antes de fazer alterações. Desconecte quando quiser.",
    );
    expect(screen.getByLabelText("Da galeria do Suup")).toBeTruthy();
  });

  it("a link to a host the connector does not declare is not drawn as a button", async () => {
    setup("connected", true, card({ action: "authorize_app", url: "https://evil.example/s/abc" }));
    await screen.findByTestId("connect-card-status");
    expect(screen.queryByTestId("connect-card-primary")).toBeNull();
  });

  it("a link of the right host but not under /link/ (the MCP address itself) is not a button", async () => {
    setup(
      "connected",
      true,
      card({ action: "authorize_app", url: "https://connect.composio.dev/mcp" }),
    );
    await screen.findByTestId("connect-card-status");
    expect(screen.queryByTestId("connect-card-primary")).toBeNull();
  });

  it("an expired link says so and offers no button", async () => {
    setup(
      "connected",
      true,
      card({
        action: "authorize_app",
        url: "https://connect.composio.dev/link/lk_abc",
        expiresAt: "2020-01-01T00:00:00Z",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("connect-card-status").textContent).toBe("Expirou: peça outro"),
    );
    expect(screen.queryByTestId("connect-card-primary")).toBeNull();
  });

  it("installed but not given to the bot: 'Liberar para o Nova' grants in place", async () => {
    const t = setup("connected", false, card());
    const button = await waitFor(async () => {
      const b = await primary();
      expect(b.textContent).toBe("Liberar para o Nova");
      return b;
    });
    expect(screen.getByTestId("connect-card-status").textContent).toBe(
      "Conectado · Nova ainda sem acesso",
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(t.api.connectors.grant).toHaveBeenCalledWith("composio", BOT, { tools: "all" }),
    );
  });

  it("not connected yet: the button is 'Adicionar chave' for a token entry; turned off: 'Ligar'", async () => {
    setup("needs_secret", false, card());
    await waitFor(async () => expect((await primary()).textContent).toBe("Adicionar chave"));
    cleanup();
    setup("off", true, card());
    await waitFor(async () => expect((await primary()).textContent).toBe("Ligar"));
  });

  it("connected and given: only 'Gerenciar', which opens the plugin's page", async () => {
    setup("connected", true, card());
    await waitFor(() =>
      expect(screen.getByTestId("connect-card-status").textContent).toBe(
        "Conectado · Nova pode usar",
      ),
    );
    expect(screen.queryByTestId("connect-card-primary")).toBeNull();
    fireEvent.click(screen.getByTestId("connect-card-manage"));
    expect(useUi.getState()).toMatchObject({
      view: "connectors",
      plugin: { kind: "catalog", id: "composio" },
    });
  });
});
