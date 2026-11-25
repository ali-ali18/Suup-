import {
  ApiError,
  type CatalogItem,
  type CatalogStatus,
  catalogEntrySchema,
  type SuupClient,
  type WebSearchSettings,
} from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The server's own gallery, from its source: the step is fed exactly what the server would list.
import {
  CONNECTOR_CATALOG,
  type CatalogEntry as ServerEntry,
} from "../../../../../packages/connectors/src/catalog.js";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import {
  connectorsStepDone,
  galleryStart,
  markConnectorsStepDone,
  offersConnectorsStep,
} from "../../lib/welcome.js";
import { makeConnector, makeSecret } from "../../test-fixtures.js";
import { TipProvider } from "../../ui/tooltip.js";
import { Stage } from "../welcome/Stage.js";
import { ConnectorsStep } from "./ConnectorsStep.js";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

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
    authHosts: [...(e.authHosts ?? [])],
    authLinkSegment: e.authLinkSegment ?? null,
    deniedTools: [...(e.deniedTools ?? [])],
  });
}

const SERVER = CONNECTOR_CATALOG.map(asApi);
const entryOf = (id: string) => {
  const found = SERVER.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

function item(id: string, status?: CatalogStatus): CatalogItem {
  const entry = entryOf(id);
  const s = status ?? (entry.availability === "ready" ? "available" : "unverified");
  return {
    entry,
    status: s,
    connector: s === "available" || s === "unverified" ? null : id,
    detail: s === "unverified" ? entry.unverifiedReason : null,
    login: null,
  };
}

const fresh = (): CatalogItem[] => SERVER.map((e) => item(e.id));
const FLOW = "11111111-1111-4111-8111-111111111111";
const LATER = () => new Date(Date.now() + 600_000);

function setup(
  options: {
    list?: CatalogItem[];
    api?: Record<string, unknown>;
    search?: WebSearchSettings;
    onDone?: () => void;
    startsAt?: "corner" | "gallery";
  } = {},
) {
  let current = options.list ?? fresh();
  const extra = options.api ?? {};
  const api = {
    info: vi.fn(async () => ({ timeZone: null, timeZoneSource: null, oauthCallback: "loopback" })),
    connectorCatalog: {
      list: vi.fn(async () => current),
      install: vi.fn(),
      setToken: vi.fn(async () => {}),
      ...(extra.connectorCatalog as object),
    },
    webSearch: { get: vi.fn(async () => options.search ?? { enabled: true, providers: [] }) },
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
      update: vi.fn(),
      ...(extra.connectors as object),
    },
    vault: { set: vi.fn(async (name: string) => makeSecret({ name })) },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const openUrl = vi.fn();
  const services = {
    api,
    sync,
    data: store,
    platform: { openUrl },
    mode: "local",
  } as unknown as Services;
  const onDone = options.onDone ?? vi.fn();
  render(
    <TipProvider>
      <ServicesProvider services={services}>
        <Stage startsAt={options.startsAt ?? "gallery"}>
          <ConnectorsStep onDone={onDone} pollMs={20} />
        </Stage>
      </ServicesProvider>
    </TipProvider>,
  );
  return {
    api,
    openUrl,
    onDone,
    serve(next: CatalogItem[]) {
      current = next;
    },
  };
}

const rows = () => screen.getAllByTestId("connector-item");
const rowOf = (id: string) =>
  rows().find((r) => r.getAttribute("data-plugin") === id) as HTMLElement;
const bot = () => screen.getByTestId("stage-bot");

describe("the connectors step draws what the server offers", () => {
  it("every entry of the gallery, each once, in sections, with the server's name and line", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(new Set(rows().map((r) => r.getAttribute("data-plugin")))).toEqual(
      new Set(SERVER.map((e) => e.id)),
    );
    const github = rowOf("github");
    expect(github.textContent).toContain(entryOf("github").name);
    expect(github.textContent).toContain(entryOf("github").description);
    expect(screen.getByText("Conecte o que você usa")).toBeTruthy();
    expect(screen.getByText("É opcional: dá para conectar depois, quando quiser.")).toBeTruthy();
  });

  it("nothing is fixed: an entry the test invents shows up (in Outros), and a shorter gallery shows less", async () => {
    const novo = {
      ...item("notion"),
      entry: { ...entryOf("notion"), id: "acme-notas", name: "Acme Notas" },
    };
    setup({ list: [...fresh(), novo] });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length + 1));
    const row = rowOf("acme-notas");
    expect(row.textContent).toContain("Acme Notas");
    expect(row.closest("[data-testid='connectors-section']")?.getAttribute("data-category")).toBe(
      "Outros",
    );
    cleanup();
    setup({ list: [fresh()[0] as CatalogItem] });
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it("the cards are a grid (3, then 2, then 1 column) in a box of limited height that scrolls, with the fade", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    const box = screen.getByTestId("gallery-box");
    expect(box.className).toContain("max-h-gallery-list");
    expect(screen.getByTestId("gallery-list").className).toContain("overflow-y-auto");
    expect(within(box).getAllByTestId("scroll-fade")).toHaveLength(2);
    const grid = rows()[0]?.parentElement as HTMLElement;
    expect(grid.className).toContain("grid-cols-3");
    expect(grid.className).toContain("compact:grid-cols-2");
    expect(grid.className).toContain("narrow:grid-cols-1");
    // The frame is centred, in a column of the widest a screen gets; the head is centred too.
    expect(screen.getByTestId("connectors-step").firstElementChild?.className).toContain(
      "max-w-screen-max",
    );
    expect(screen.getByTestId("gallery-head").className).toContain("text-center");
  });

  it("'Continuar' sits under the box (outside what scrolls), is always on and fades the step out before going on", async () => {
    const t = setup();
    const go = screen.getByTestId("connectors-continue") as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    expect(screen.getByTestId("gallery-box").contains(go)).toBe(false);
    expect(screen.getByTestId("gallery-footer").contains(go)).toBe(true);
    fireEvent.click(go);
    expect(screen.getByTestId("connectors-step").className).toContain("animate-welcome-out");
    // The crew fades with the step; the main bot stays and goes on to "Crie seu bot".
    expect(screen.getByTestId("stage-crew").className).toContain("animate-welcome-out");
    await waitFor(() => expect(t.onDone).toHaveBeenCalledTimes(1));
    expect(t.api.connectorCatalog.install).not.toHaveBeenCalled();
  });

  it("reduced motion: everything is already in place and 'Continuar' goes on at once", async () => {
    document.documentElement.dataset.motion = "reduce";
    try {
      const t = setup();
      await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
      for (const part of ["gallery-head", "gallery-box", "gallery-footer"]) {
        expect(screen.getByTestId(part).style.animationDelay).toBe("0ms");
      }
      for (const one of screen.getAllByTestId("stage-crew-bot")) {
        expect(one.style.animationDelay).toBe("0ms");
      }
      fireEvent.click(screen.getByTestId("connectors-continue"));
      expect(t.onDone).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.removeAttribute("data-motion");
    }
  });

  it("a server that cannot list: a friendly sentence, and Continuar still works", async () => {
    const t = setup({
      api: {
        connectorCatalog: {
          list: vi.fn(async () => {
            throw new ApiError("network", "ECONNRESET at 10.0.0.1");
          }),
        },
      },
    });
    await screen.findByTestId("connectors-load-error");
    expect(screen.getByTestId("connectors-load-error").textContent).not.toContain("ECONNRESET");
    fireEvent.click(screen.getByTestId("connectors-continue"));
    await waitFor(() => expect(t.onDone).toHaveBeenCalled());
  });

  it("Em breve has no Conectar; a connected entry says so in words", async () => {
    const list = fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i));
    setup({ list });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(within(rowOf("notion")).getByTestId("connector-state").textContent).toBe("Conectado");
    expect(within(rowOf("notion")).queryByTestId("connector-connect")).toBeNull();
    expect(within(rowOf("google-workspace")).queryByTestId("connector-connect")).toBeNull();
  });
});

describe("the same bot goes to the top, in the middle", () => {
  it("from the corner it travels (place with the curve, size linearly), shrinking, and arrives", async () => {
    setup({ startsAt: "corner" });
    expect(bot().dataset.mode).toBe("gallery");
    expect(bot().dataset.traveling).toBe("true");
    expect(bot().style.transition).toContain("scale var(--duration-travel) linear");
    expect(bot().style.transition).toContain("translate var(--duration-travel) var(--ease-bot-in)");
    // Smaller than in the corner, centred in width.
    expect(Number.parseFloat(bot().style.scale)).toBeLessThan(1);
    await waitFor(() => expect(bot().dataset.traveling).toBe("false"), { timeout: 3000 });
    expect(screen.getAllByTestId("stage-bot")).toHaveLength(1);
  });

  it("a bot born there (the local server) is already in place: no trip, the crew soon after", async () => {
    setup({ startsAt: "gallery" });
    expect(bot().dataset.mode).toBe("gallery");
    expect(bot().dataset.traveling).toBe("false");
    const start = galleryStart(false);
    const nearest = screen.getAllByTestId("stage-crew-bot")[0] as HTMLElement;
    expect(Number.parseInt(nearest.style.animationDelay, 10)).toBe(start.crew);
  });
});

describe("the same bot reacts", () => {
  it("one main bot only, the stage's, at the top in the middle; the crew is only decoration", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(screen.getAllByTestId("stage-bot")).toHaveLength(1);
    expect(bot().dataset.mode).toBe("gallery");
    const crew = screen.getByTestId("stage-crew");
    expect(crew.getAttribute("aria-hidden")).toBe("true");
    expect(crew.className).toContain("pointer-events-none");
    const mates = screen.getAllByTestId("stage-crew-bot");
    expect(mates).toHaveLength(Number(crew.dataset.count));
    expect(mates.length).toBeGreaterThan(0);
    // The same number on each side; every one a mascot of the engine, inside the crew's layer.
    expect(mates.filter((m) => m.dataset.side === "left")).toHaveLength(mates.length / 2);
    expect(document.querySelectorAll("[data-mascot]")).toHaveLength(1 + mates.length);
    expect(crew.querySelectorAll("[data-mascot]")).toHaveLength(mates.length);
    // Different shapes and colours, none of them the stage bot's own white circle.
    const looks = mates.map((m) => {
      const face = m.querySelector("[data-mascot]") as HTMLElement;
      return `${face.dataset.mascot}/${face.dataset.color}`;
    });
    expect(new Set(looks).size).toBe(mates.length);
    expect(looks).not.toContain("blob/branco");
    // They come out of the middle: the nearest pair first.
    const delays = mates.map((m) => Number.parseInt(m.style.animationDelay, 10));
    const nearest = mates.find((m) => m.dataset.rank === "0") as HTMLElement;
    expect(Number.parseInt(nearest.style.animationDelay, 10)).toBe(Math.min(...delays));
  });

  it("the crew smiles when something connects, and goes back to calm", async () => {
    let status = "pending";
    const install = vi.fn(async () => ({
      item: item("notion", "needs_login"),
      next: "login" as const,
      connector: makeConnector({ name: "notion", enabled: false }),
    }));
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
    for (const mate of screen.getAllByTestId("stage-crew-bot")) {
      expect(mate.dataset.state).toBe("idle");
    }
    fireEvent.click(within(rowOf("notion")).getByRole("button", { name: "Conectar Notion" }));
    await waitFor(() => expect(screen.getByTestId("connector-waiting")).toBeTruthy());
    t.serve(fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i)));
    status = "connected";
    await waitFor(() => expect(bot().dataset.state).toBe("surprised"));
    for (const mate of screen.getAllByTestId("stage-crew-bot")) {
      expect(mate.dataset.state).toBe("smiling");
    }
    await waitFor(() => expect(bot().dataset.state).not.toBe("surprised"), { timeout: 3000 });
    for (const mate of screen.getAllByTestId("stage-crew-bot")) {
      expect(mate.dataset.state).toBe("idle");
    }
  });

  it("the crew has nothing to click or focus", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    for (const mate of screen.getAllByTestId("stage-crew-bot")) {
      expect(mate.querySelector("button, a, input, [tabindex]")).toBeNull();
    }
  });

  it("curious about the row under the pointer, calm again when it leaves", async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    expect(bot().dataset.state).toBe("idle");
    fireEvent.pointerEnter(rowOf("github"));
    await waitFor(() => expect(bot().dataset.state).toBe("asking"));
    fireEvent.pointerLeave(rowOf("github"));
    await waitFor(() => expect(bot().dataset.state).toBe("idle"));
  });

  it("connecting by login: the bot thinks while it waits, the row turns Conectado and the eyes go wide", async () => {
    let status = "pending";
    const install = vi.fn(async () => ({
      item: item("notion", "needs_login"),
      next: "login" as const,
      connector: makeConnector({ name: "notion", enabled: false }),
    }));
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
    fireEvent.click(within(rowOf("notion")).getByRole("button", { name: "Conectar Notion" }));
    await waitFor(() => expect(screen.getByTestId("connector-waiting")).toBeTruthy());
    expect(t.openUrl).toHaveBeenCalledWith("https://auth.example.com/authorize?for=notion");
    expect(bot().dataset.state).toBe("pondering");
    t.serve(fresh().map((i) => (i.entry.id === "notion" ? item("notion", "connected") : i)));
    status = "connected";
    await waitFor(() =>
      expect(within(rowOf("notion")).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
    await waitFor(() => expect(bot().dataset.state).toBe("surprised"));
    expect(screen.queryByTestId("connector-waiting")).toBeNull();
  });

  it("a failed login makes the bot sorry, and the row can try again", async () => {
    const install = vi.fn(async () => ({
      item: item("notion", "needs_login"),
      next: "login" as const,
      connector: makeConnector({ name: "notion", enabled: false }),
    }));
    setup({
      api: {
        connectorCatalog: { install },
        connectors: {
          oauthStatus: vi.fn(async () => ({
            status: "failed",
            flowId: FLOW,
            expiresAt: LATER(),
            error: "access_denied",
          })),
        },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(rowOf("notion")).getByRole("button", { name: "Conectar Notion" }));
    await screen.findByTestId("connector-error");
    expect(screen.getByTestId("connector-error").textContent).not.toContain("access_denied");
    await waitFor(() => expect(bot().dataset.state).toBe("failed"));
  });
});

describe("connecting from the entrance", () => {
  it("a token entry opens the secure form (never a loose field), and ends Conectado", async () => {
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
    fireEvent.click(within(rowOf("github")).getByRole("button", { name: "Conectar GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Token do GitHub" });
    expect(dialog.textContent).not.toContain("GITHUB_TOKEN");
    const field = within(dialog).getByTestId("secret-input") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "made_up_value_for_the_test" } });
    t.serve(fresh().map((i) => (i.entry.id === "github" ? item("github", "connected") : i)));
    fireEvent.click(within(dialog).getByTestId("secret-write"));
    // the token goes to the connector's own route, never to the owner's vault
    await waitFor(() =>
      expect(t.api.connectorCatalog.setToken).toHaveBeenCalledWith(
        "github",
        "made_up_value_for_the_test",
      ),
    );
    expect(t.api.vault.set).not.toHaveBeenCalled();
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(rowOf("github")).getByTestId("connector-state").textContent).toBe("Conectado"),
    );
    expect(document.body.textContent).not.toContain("made_up_value_for_the_test");
  });

  it("an entry with a notice about a third party asks first, in a window over the step", async () => {
    const t = setup();
    await waitFor(() => expect(rows()).toHaveLength(SERVER.length));
    fireEvent.click(within(rowOf("composio")).getByTestId("connector-connect"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("connector-disclosure").textContent).toBe(
      "Pelo Composio, seus logins ficam guardados na nuvem deles.",
    );
    expect(t.api.connectorCatalog.install).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Agora não"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(t.api.connectorCatalog.install).not.toHaveBeenCalled();
  });

  it("a web search engine takes its key by the same secure form", async () => {
    const search = {
      enabled: true,
      providers: [
        {
          id: "brave",
          label: "Brave",
          position: 1,
          state: "no_key",
          searchesThisMonth: 0,
          keyNames: { secret: "BRAVE_KEY" },
          plugin: {
            id: "brave",
            description: "Pesquisa na web.",
            category: "Pesquisa na web",
            notes: [],
            keySteps: ["Crie uma chave no site."],
          },
        },
      ],
    } as unknown as WebSearchSettings;
    setup({ search });
    await waitFor(() => expect(rowOf("brave")).toBeTruthy());
    fireEvent.click(within(rowOf("brave")).getByRole("button", { name: "Conectar Brave" }));
    expect(await screen.findByRole("dialog", { name: "Chave do Brave" })).toBeTruthy();
  });
});

describe("when the step shows", () => {
  it("on a server with no bot, once; never with bots, never after it was done", () => {
    expect(offersConnectorsStep(0)).toBe(true);
    expect(offersConnectorsStep(2)).toBe(false);
    expect(connectorsStepDone()).toBe(false);
    markConnectorsStepDone();
    expect(connectorsStepDone()).toBe(true);
    expect(offersConnectorsStep(0)).toBe(false);
  });
});
