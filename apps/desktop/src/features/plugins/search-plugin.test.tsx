import type { SearchProvider, SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeSecret } from "../../test-fixtures.js";
import { SearchPluginPage, SearchRow } from "./SearchPlugin.js";

afterEach(cleanup);

const provider = (over: Partial<SearchProvider> = {}): SearchProvider => ({
  id: "tavily",
  label: "Tavily",
  position: 2,
  state: "no_key",
  searchesThisMonth: 12,
  keyNames: { secret: "TAVILY_API_KEY", env: "TAVILY_API_KEY" },
  plugin: {
    id: "tavily",
    category: "Pesquisa na web",
    description: "Pesquisa na web feita para agentes.",
    notes: ["A conta grátis tem mil buscas por mês."],
    keySteps: ["Crie uma conta grátis no site do Tavily (mil buscas por mês, sem cartão)."],
  },
  ...over,
});
const brave = provider({ id: "brave", label: "Brave Search", position: 1, state: "ready" });

function setup(p: SearchProvider, autoStart = false) {
  const api = {
    vault: { set: vi.fn(async (name: string) => makeSecret({ name })) },
    webSearch: { setKey: vi.fn(async () => {}) },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const reload = vi.fn(async () => {});
  render(
    <ServicesProvider services={{ api, sync, data: store } as unknown as Services}>
      <SearchPluginPage
        entry={{ provider: p, plugin: p.plugin as NonNullable<SearchProvider["plugin"]> }}
        all={[brave, p]}
        onBack={() => {}}
        reload={reload}
        autoStart={autoStart}
      />
    </ServicesProvider>,
  );
  return { api, reload };
}

describe("the page of a search engine", () => {
  it("says where it stands in words, this month's searches and its place in the queue", () => {
    setup(provider());
    expect(screen.getByTestId("search-plugin-state").textContent).toBe("Sem chave");
    expect(screen.getByTestId("search-plugin-usage").textContent).toBe("12 buscas este mês");
    expect(screen.getByTestId("search-plugin-queue").textContent).toContain("2º da fila");
    expect(screen.getByTestId("search-plugin-queue").textContent).toContain("Brave Search");
    expect(screen.getByTestId("search-key").textContent).toBe("Adicionar chave");
    expect(document.body.textContent).not.toContain("TAVILY_API_KEY");
  });

  it("'Adicionar chave' opens the secure form (the key goes to the engine, not the vault; steps from the catalog), and the key never shows", async () => {
    const t = setup(provider());
    fireEvent.click(screen.getByTestId("search-key"));
    const dialog = await screen.findByRole("dialog", { name: "Chave do Tavily" });
    expect(within(dialog).getByTestId("secret-steps").textContent).toContain("mil buscas");
    expect(dialog.textContent).not.toContain("TAVILY_API_KEY");
    const field = within(dialog).getByTestId("secret-input") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "tvly-made-up" } });
    fireEvent.click(within(dialog).getByTestId("secret-write"));
    await waitFor(() =>
      expect(t.api.webSearch.setKey).toHaveBeenCalledWith("tavily", "tvly-made-up"),
    );
    expect(t.api.vault.set).not.toHaveBeenCalled();
    await waitFor(() => expect(t.reload).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain("tvly-made-up");
  });

  it("opens the form by itself when the gallery row's button was clicked; with a key it says 'Trocar a chave'", async () => {
    setup(provider(), true);
    expect(await screen.findByRole("dialog", { name: "Chave do Tavily" })).toBeTruthy();
    cleanup();
    setup(provider({ state: "quota" }));
    expect(screen.getByTestId("search-key").textContent).toBe("Trocar a chave");
    expect(screen.getByTestId("search-plugin-state").textContent).toBe("Cota do mês usada");
  });
});

describe("the row of a search engine in the gallery", () => {
  it("is a plugin row with 'Adicionar chave' while it has no key, and its state once it has", () => {
    const onOpen = vi.fn();
    const p = provider();
    render(
      <ul>
        <SearchRow entry={{ provider: p, plugin: p.plugin as never }} onOpen={onOpen} />
      </ul>,
    );
    const row = screen.getByTestId("connector-item");
    expect(row.getAttribute("data-plugin")).toBe("tavily");
    fireEvent.click(within(row).getByTestId("connector-connect"));
    expect(onOpen).toHaveBeenCalledWith(true);
    cleanup();
    const q = provider({ state: "quota" });
    render(
      <ul>
        <SearchRow entry={{ provider: q, plugin: q.plugin as never }} onOpen={onOpen} />
      </ul>,
    );
    expect(screen.getByTestId("connector-state").textContent).toBe("Cota do mês usada");
    expect(screen.queryByTestId("connector-connect")).toBeNull();
  });
});
