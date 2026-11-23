import {
  ApiError,
  type CatalogItem,
  type CatalogStatus,
  catalogEntrySchema,
  type SuupClient,
} from "@suup/api";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The server's own gallery, from its source: the screen is fed exactly what the server would list.
import {
  CONNECTOR_CATALOG,
  type CatalogEntry as ServerEntry,
} from "../../../../../packages/connectors/src/catalog.js";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import type { ServerMode } from "../../lib/platform.js";
import { makeConnector, makeSecret } from "../../test-fixtures.js";
import { appearanceOf, CATEGORIES } from "./appearance.js";
import { ConnectorsScreen } from "./ConnectorsScreen.js";

afterEach(cleanup);
beforeEach(() => useUi.setState({ view: "connectors", settingsOpen: false }));

/** A gallery entry of the server, as the API sends it (the optional fields as `null`). */
function asApi(e: ServerEntry) {
  const auth =
    e.auth.kind === "oauth"
      ? { kind: "oauth" as const, scopes: e.auth.scopes === undefined ? null : [...e.auth.scopes] }
      : e.auth.kind === "token"
        ? { ...e.auth, prefix: e.auth.prefix ?? null, steps: [...e.auth.steps] }
        : { ...e.auth, steps: [...e.auth.steps] };
  return catalogEntrySchema.parse({
    ...JSON.parse(JSON.stringify(e)),
    auth,
    unverifiedReason: e.unverifiedReason ?? null,
    disclosure: e.disclosure ?? null,
  });
}

const SERVER = CONNECTOR_CATALOG.map(asApi);
const entryOf = (id: string) => {
  const found = SERVER.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

function item(id: string, status?: CatalogStatus, over: Partial<CatalogItem> = {}): CatalogItem {
  const entry = entryOf(id);
  const s = status ?? (entry.availability === "ready" ? "available" : "unverified");
  return {
    entry,
    status: s,
    connector: s === "available" || s === "unverified" ? null : id,
    detail: s === "unverified" ? entry.unverifiedReason : null,
    login: null,
    ...over,
  };
}

/** The list as the server answers it today: every entry, nothing installed. */
const fresh = (): CatalogItem[] => SERVER.map((e) => item(e.id));

const FLOW = "11111111-1111-4111-8111-111111111111";
const LATER = () => new Date(Date.now() + 600_000);

function setup(
  options: {
    list?: CatalogItem[] | (() => CatalogItem[]);
    mode?: ServerMode;
    api?: Record<string, unknown>;
  } = {},
) {
  let current = options.list ?? fresh();
  const list = vi.fn(async () => (typeof current === "function" ? current() : current));
  const openUrl = vi.fn();
  const extra = options.api ?? {};
  const api = {
    connectorCatalog: { list, install: vi.fn(), ...(extra.connectorCatalog as object) },
    connectors: {
      list: vi.fn(async () => []),
      oauthStart: vi.fn(async (name: string) => ({
        authorizationUrl: `https://auth.example.com/authorize?for=${name}`,
        flowId: FLOW,
        redirectUri: "http://127.0.0.1:4100/callback",
        expiresAt: LATER(),
      })),
      oauthStatus: vi.fn(async () => ({
        status: "pending",
        flowId: FLOW,
        expiresAt: LATER(),
        error: null,
      })),
      oauthComplete: vi.fn(),
      oauthDisconnect: vi.fn(async (name: string) => makeConnector({ name, enabled: false })),
      update: vi.fn(async (name: string) => makeConnector({ name, enabled: true })),
      ...(extra.connectors as object),
    },
    vault: {
      set: vi.fn(async (name: string) => makeSecret({ name })),
      ...(extra.vault as object),
    },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = {
    api,
    sync,
    data: store,
    platform: { openUrl },
    mode: options.mode ?? "local",
  } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ConnectorsScreen pollMs={20} />
    </ServicesProvider>,
  );
  return {
    api,
    openUrl,
    list,
    /** What the server will list from now on. */
    serve(next: CatalogItem[]) {
      current = next;
    },
  };
}

const rows = () => screen.getAllByTestId("connector-item");
const itemOf = (id: string) =>
  rows().find((i) => i.getAttribute("data-plugin") === id) as HTMLElement;
const openPage = (id: string) => fireEvent.click(itemOf(id).querySelector("button") as HTMLElement);
const page = () => screen.getByTestId("connector-page");

describe("the connectors screen draws what the server offers", () => {
  it("exactly the entries of the server's gallery, each once, in its order within each section", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const drawn = rows().map((r) => r.getAttribute("data-plugin"));
    const expected = CATEGORIES.flatMap((c) =>
      SERVER.filter((e) => appearanceOf(e.id).category === c).map((e) => e.id),
    );
    expect(drawn).toEqual(expected);
    expect(new Set(drawn)).toEqual(new Set(SERVER.map((e) => e.id)));
    // what the showcase had and the server does not offer is not drawn
    for (const gone of ["gmail", "google-docs", "trello", "todoist", "discord", "higgsfield"]) {
      expect(drawn, gone).not.toContain(gone);
    }
    // the name and the line are the server's
    const github = itemOf("github");
    expect(github.textContent).toContain(entryOf("github").name);
    expect(github.textContent).toContain(entryOf("github").description);
  });

  it("follows the server's order: the same entries reversed are drawn reversed", async () => {
    setup({ list: fresh().reverse() });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const section = screen
      .getAllByTestId("connectors-section")
      .find((s) => s.getAttribute("data-category") === "Desenvolvimento") as HTMLElement;
    expect(
      within(section)
        .getAllByTestId("connector-item")
        .map((r) => r.getAttribute("data-plugin")),
    ).toEqual(["stackoverflow", "figma", "github"]);
  });

  it("sections with their counts, only those with entries", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const sections = screen.getAllByTestId("connectors-section");
    for (const section of sections) {
      const category = section.getAttribute("data-category");
      const count = SERVER.filter((e) => appearanceOf(e.id).category === category).length;
      expect(count, category ?? "").toBeGreaterThan(0);
      expect(within(section).getByRole("heading").textContent).toBe(`${category}${count}`);
    }
  });

  it("the look by id: the logo on its tile, the brand colour of a one-colour brand, Google's logo for Google Workspace", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const logo = itemOf("github").querySelector("img[data-logo='github']");
    expect(logo?.getAttribute("alt")).toBe("");
    expect(logo?.parentElement?.className).toContain("bg-tile-black");
    const linear = itemOf("linear").querySelector("svg[data-brand='linear']");
    expect(linear?.getAttribute("class")).toContain("text-tile-white");
    expect((linear?.parentElement as HTMLElement | undefined)?.style.backgroundColor).toBe(
      "rgb(94, 106, 210)",
    );
    const google = itemOf("google-workspace").querySelector("img[data-logo='google-workspace']");
    expect(google?.getAttribute("src")).toContain("google");
    expect(google?.parentElement?.className).toContain("bg-raised");
    // every entry of the server has its own look: no plug today
    for (const e of SERVER) expect(itemOf(e.id).querySelector("svg.lucide-plug"), e.id).toBeNull();
  });

  it("an entry the app has no look for: the neutral grey and the plug, in Outros, with no band of examples", async () => {
    const novo = {
      ...item("notion"),
      entry: { ...entryOf("notion"), id: "novo-servico", name: "Serviço novo" },
    };
    setup({ list: [...fresh(), novo] });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length + 1));
    const row = itemOf("novo-servico");
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("svg.lucide-plug")).not.toBeNull();
    expect(row.querySelector("svg.lucide-plug")?.parentElement?.className).toContain("bg-raised");
    expect(row.closest("[data-testid='connectors-section']")?.getAttribute("data-category")).toBe(
      "Outros",
    );
    openPage("novo-servico");
    expect(screen.queryByTestId("connector-examples")).toBeNull();
    expect(within(page()).getByTestId("connector-info").textContent).toContain("CategoriaOutros");
  });

  it("'a confirmar': unavailable, with the server's reason, and no Conectar", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const so = itemOf("stackoverflow");
    const tag = within(so).getByTestId("connector-state");
    expect(tag.textContent).toBe("A confirmar");
    expect(tag.getAttribute("title")).toBe(entryOf("stackoverflow").unverifiedReason);
    expect(within(so).queryByTestId("connector-connect")).toBeNull();
    openPage("stackoverflow");
    expect(within(page()).getByTestId("connector-unverified").textContent).toContain(
      entryOf("stackoverflow").unverifiedReason ?? "",
    );
    const main = within(page()).getByTestId("connector-main") as HTMLButtonElement;
    expect(main.disabled).toBe(true);
    // the server's notes (Stack Overflow is in beta) are on the page
    expect(within(page()).getByTestId("connector-notes").textContent).toContain("beta");
  });

  it("Google Workspace (an OAuth app of the owner's own): its steps, as text, without a way to connect", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    openPage("google-workspace");
    const connection = within(page()).getByTestId("connector-connection");
    expect(connection.textContent).toContain("Google Cloud Console");
    expect((within(page()).getByTestId("connector-main") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the page shows what the server declares: notes (Figma's limit), source, licence, hosts", async () => {
    const { openUrl } = setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    openPage("figma");
    const info = within(page()).getByTestId("connector-info").textContent ?? "";
    expect(info).toContain("CategoriaDesenvolvimento");
    expect(info).toContain("mcp.figma.com");
    expect(info).toContain(entryOf("figma").license);
    expect(within(page()).getByTestId("connector-notes").textContent).toContain(
      "6 chamadas por mês",
    );
    fireEvent.click(within(page()).getByTestId("connector-site"));
    expect(openUrl).toHaveBeenCalledWith(entryOf("figma").source);
  });

  it("Composio: the third-party notice is on its page, and the line's Conectar opens the page first", async () => {
    const { api } = setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("composio")).getByTestId("connector-connect"));
    expect(within(page()).getByTestId("connector-disclosure").textContent).toContain(
      "serviço de terceiros",
    );
    expect(api.connectorCatalog.install).not.toHaveBeenCalled();
  });

  it("a server that cannot list says so in its words", async () => {
    setup({
      api: {
        connectorCatalog: {
          list: vi.fn(async () => {
            throw new ApiError("internal_error", "O banco não respondeu.");
          }),
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("connectors-load-error").textContent).toContain(
        "O banco não respondeu.",
      ),
    );
  });
});

describe("connecting with OAuth in the browser", () => {
  const notionInstall = () =>
    vi.fn(async () => ({
      item: item("notion", "needs_login"),
      next: "login" as const,
      connector: makeConnector({ name: "notion", enabled: false }),
    }));

  it("install, start, the system browser, 'Aguardando login…', then Conectado when the server says so", async () => {
    let status = "pending";
    const install = notionInstall();
    const t = setup({
      api: {
        connectorCatalog: { install },
        connectors: {
          oauthStatus: vi.fn(async () => ({
            status,
            flowId: FLOW,
            expiresAt: LATER(),
            error: null,
          })),
        },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByRole("button", { name: "Conectar Notion" }));
    await waitFor(() => expect(screen.getByTestId("connector-waiting")).toBeTruthy());
    expect(install).toHaveBeenCalledWith("notion");
    expect(t.api.connectors.oauthStart).toHaveBeenCalledWith("notion");
    expect(t.openUrl).toHaveBeenCalledWith("https://auth.example.com/authorize?for=notion");
    expect(within(page()).getByTestId("connector-state").textContent).toBe("Aguardando login…");
    expect(screen.getByTestId("connector-waiting").textContent).toContain(
      "Aguardando login no navegador…",
    );
    // on this computer the browser comes back by itself: no field to paste
    expect(screen.queryByTestId("connector-paste")).toBeNull();
    await waitFor(() => expect(t.api.connectors.oauthStatus).toHaveBeenCalledWith("notion"));
    // the browser came back to the server
    t.serve(fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i)));
    status = "connected";
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
    expect(screen.queryByTestId("connector-waiting")).toBeNull();
    expect(within(page()).getByTestId("connector-main").textContent).toBe("Desconectar");
    // the connectors of Configurações were read again
    expect(t.api.connectors.list).toHaveBeenCalled();
    // and the page leads to the grants per bot of this connector
    fireEvent.click(within(page()).getByTestId("connector-open-settings"));
    expect(useUi.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: "connectors",
      settingsConnector: "notion",
    });
  });

  it("Cancelar stops waiting, and nothing is asked any more", async () => {
    const t = setup({ api: { connectorCatalog: { install: notionInstall() } } });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByTestId("connector-connect"));
    await waitFor(() => expect(screen.getByTestId("connector-waiting")).toBeTruthy());
    await waitFor(() => expect(t.api.connectors.oauthStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("connector-cancel"));
    expect(screen.queryByTestId("connector-waiting")).toBeNull();
    const calls = t.api.connectors.oauthStatus.mock.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(t.api.connectors.oauthStatus.mock.calls.length).toBe(calls);
  });

  it("'Abrir a página de login de novo' opens the same address again", async () => {
    const t = setup({ api: { connectorCatalog: { install: notionInstall() } } });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByTestId("connector-connect"));
    await waitFor(() => expect(screen.getByTestId("connector-waiting")).toBeTruthy());
    fireEvent.click(screen.getByTestId("connector-reopen"));
    expect(t.openUrl).toHaveBeenCalledTimes(2);
  });

  it("a failed login shows the server's message in its words, and the entry can try again", async () => {
    const t = setup({
      api: {
        connectorCatalog: { install: notionInstall() },
        connectors: {
          oauthStatus: vi.fn(async () => ({
            status: "error",
            flowId: FLOW,
            expiresAt: null,
            error: "O servidor de autorização recusou o registro do app.",
          })),
        },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByTestId("connector-connect"));
    t.serve(
      fresh().map((i) =>
        i.entry.id === "notion"
          ? item("notion", "error", {
              detail: "O servidor de autorização recusou o registro do app.",
            })
          : i,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("connector-error").textContent).toBe(
        "O servidor de autorização recusou o registro do app.",
      ),
    );
    expect(screen.queryByTestId("connector-waiting")).toBeNull();
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-main").textContent).toBe("Tentar de novo"),
    );
    // Tentar de novo starts the login again, without installing again
    fireEvent.click(within(page()).getByTestId("connector-main"));
    await waitFor(() => expect(t.api.connectors.oauthStart).toHaveBeenCalledTimes(2));
  });

  it("a refused install shows the server's message", async () => {
    setup({
      api: {
        connectorCatalog: {
          install: vi.fn(async () => {
            throw new ApiError(
              "conflict",
              "Já existe um conector chamado notion que não veio da galeria: renomeie ou remova antes.",
            );
          }),
        },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByTestId("connector-connect"));
    await waitFor(() =>
      expect(screen.getByTestId("connector-error").textContent).toContain("não veio da galeria"),
    );
    expect(within(page()).getByTestId("connector-main").textContent).toBe("Conectar");
  });

  it("a server on a VPS: one line says why, and the address the browser stopped at completes the login", async () => {
    const oauthComplete = vi.fn(async () => ({
      status: "connected",
      flowId: null,
      expiresAt: null,
      error: null,
    }));
    const t = setup({
      mode: "vps",
      api: { connectorCatalog: { install: notionInstall() }, connectors: { oauthComplete } },
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("notion")).getByTestId("connector-connect"));
    const paste = await screen.findByTestId("connector-paste");
    expect(paste.textContent).toContain("Cole aqui o endereço em que o navegador parou");
    expect(paste.textContent).toContain("o navegador não consegue voltar a ele");
    const done = within(paste).getByTestId("connector-complete") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    const address = "http://127.0.0.1:4100/callback?code=abc&state=xyz";
    fireEvent.change(within(paste).getByRole("textbox"), { target: { value: address } });
    t.serve(fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i)));
    fireEvent.click(done);
    await waitFor(() =>
      expect(oauthComplete).toHaveBeenCalledWith("notion", { flowId: FLOW, callbackUrl: address }),
    );
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
  });

  it("Desconectar asks first; confirmed, it calls the server and the entry goes back to its state", async () => {
    const t = setup({
      list: fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i)),
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    openPage("notion");
    fireEvent.click(within(page()).getByTestId("connector-main"));
    const dialog = screen.getByRole("dialog", { name: "Desconectar o Notion?" });
    // Cancelar does nothing
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(t.api.connectors.oauthDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(page()).getByTestId("connector-main"));
    t.serve(fresh().map((i) => (i.entry.id === "notion" ? item("notion", "needs_login") : i)));
    fireEvent.click(screen.getByTestId("connector-disconnect"));
    await waitFor(() => expect(t.api.connectors.oauthDisconnect).toHaveBeenCalledWith("notion"));
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-state").textContent).toBe("Precisa de login"),
    );
    expect(within(page()).getByTestId("connector-main").textContent).toBe("Fazer login");
  });
});

describe("connecting with a token (the secure form)", () => {
  it("GitHub: install, the secure form with the fixed name and the steps, then install again: Conectado", async () => {
    let calls = 0;
    const install = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? {
            item: item("github", "needs_secret"),
            next: "secret" as const,
            connector: makeConnector({ name: "github", enabled: false }),
          }
        : {
            item: item("github", "connected"),
            next: "none" as const,
            connector: makeConnector({ name: "github", enabled: true }),
          };
    });
    const t = setup({ api: { connectorCatalog: { install } } });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(itemOf("github")).getByRole("button", { name: "Conectar GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Token do GitHub" });
    // the steps of the server, and the name it declares: nothing typed for the name
    expect(within(dialog).getByTestId("secret-steps").textContent).toContain("Fine-grained tokens");
    expect(dialog.textContent).toContain("GITHUB_TOKEN");
    expect(within(dialog).queryByRole("textbox", { name: "Nome" })).toBeNull();
    // the value goes in the secure field (a password field, never a plain input of the screen)
    const field = within(dialog).getByTestId("secret-input") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "ghp_made_up_value_for_the_test" } });
    t.serve(fresh().map((i) => (i.entry.id === "github" ? item("github", "connected") : i)));
    fireEvent.click(within(dialog).getByTestId("secret-write"));
    await waitFor(() =>
      expect(t.api.vault.set).toHaveBeenCalledWith("GITHUB_TOKEN", {
        value: "ghp_made_up_value_for_the_test",
      }),
    );
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // the value never reaches the page
    expect(document.body.textContent).not.toContain("ghp_made_up_value_for_the_test");
    expect(within(page()).getByTestId("connector-main").textContent).toBe("Trocar o token");
  });

  it("an entry still waiting for its token opens the form straight away", async () => {
    const t = setup({
      list: fresh().map((i) =>
        i.entry.id === "composio"
          ? item("composio", "needs_secret", { detail: "Falta o token COMPOSIO_API_KEY no cofre." })
          : i,
      ),
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(within(itemOf("composio")).getByTestId("connector-state").textContent).toBe(
      "Precisa do token",
    );
    openPage("composio");
    expect(within(page()).getByTestId("connector-connection").textContent).toContain(
      "Falta o token COMPOSIO_API_KEY no cofre.",
    );
    fireEvent.click(within(page()).getByTestId("connector-main"));
    expect(await screen.findByRole("dialog", { name: "Token do Composio" })).toBeTruthy();
    expect(t.api.connectorCatalog.install).not.toHaveBeenCalled();
  });
});

describe("the rest of the screen", () => {
  it("search filters by name, line and section, and says so when nothing matches", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const field = screen.getByRole("searchbox", { name: "Buscar conectores" });
    fireEvent.change(field, { target: { value: "gOOgle" } });
    expect(rows().map((i) => i.getAttribute("data-plugin"))).toEqual(["google-workspace"]);
    fireEvent.change(field, { target: { value: "desenvolvimento" } });
    expect(rows().map((i) => i.getAttribute("data-plugin"))).toEqual([
      "github",
      "figma",
      "stackoverflow",
    ]);
    fireEvent.change(field, { target: { value: "xyz-nada" } });
    expect(screen.queryAllByTestId("connector-item")).toHaveLength(0);
    expect(screen.getByText("Nenhum conector encontrado")).toBeTruthy();
  });

  it("'Meus conectores' shows the logos of what the server says is connected and opens Configurações > Conectores", async () => {
    setup({
      list: fresh().map((i) =>
        i.entry.id === "github" || i.entry.id === "figma" ? item(i.entry.id, "connected") : i,
      ),
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const mine = screen.getByTestId("connectors-mine");
    expect(mine.tagName).toBe("BUTTON");
    expect(mine.getAttribute("aria-hidden")).toBeNull();
    const icons = within(mine).getAllByTestId("connectors-mine-icon");
    expect(icons.map((i) => i.getAttribute("data-plugin"))).toEqual(["github", "figma"]);
    expect(icons[0]?.parentElement?.className).toContain("flex-row-reverse");
    expect(icons[1]?.className).toContain("-mr-1.5");
    fireEvent.click(mine);
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsTab: "connectors" });
  });

  it("'Conector personalizado' opens Configurações > Conectores", async () => {
    setup();
    fireEvent.click(screen.getByTestId("connectors-add-custom"));
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsTab: "connectors" });
  });

  it("the page replaces the list: the way back, the band of its look, and Esc returns", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    openPage("notion");
    expect(screen.queryByTestId("connectors-screen")).toBeNull();
    const nav = within(page()).getByRole("navigation", { name: "Caminho" });
    expect(within(nav).getByText("Notion").getAttribute("aria-current")).toBe("page");
    expect(within(page()).getByRole("heading", { name: "Notion", level: 1 })).toBeTruthy();
    expect(within(page()).getByTestId("connector-state").textContent).toBe("Não conectado");
    const examples = within(page()).getByTestId("connector-examples");
    expect(examples.getAttribute("data-banner")).toBe("paper");
    expect(examples.className).toContain("from-banner-paper-from");
    expect(within(examples).getAllByText("Notion")).toHaveLength(3);
    fireEvent.click(within(page()).getByTestId("connector-back"));
    expect(screen.getByTestId("connectors-screen")).toBeTruthy();
    openPage("notion");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("connectors-screen")).toBeTruthy();
  });

  it("an installed connector that is off can be turned on from its page", async () => {
    const t = setup({
      list: fresh().map((i) => (i.entry.id === "linear" ? item("linear", "off") : i)),
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(within(itemOf("linear")).getByTestId("connector-state").textContent).toBe("Desligado");
    openPage("linear");
    t.serve(fresh().map((i) => (i.entry.id === "linear" ? item("linear", "connected") : i)));
    fireEvent.click(within(page()).getByTestId("connector-main"));
    await waitFor(() =>
      expect(t.api.connectors.update).toHaveBeenCalledWith("linear", { enabled: true }),
    );
    await waitFor(() =>
      expect(within(page()).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
  });
});
