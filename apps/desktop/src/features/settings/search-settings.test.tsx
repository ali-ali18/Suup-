import { ApiError, type SearchProvider, type SuupClient, type WebSearchSettings } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeSecret } from "../../test-fixtures.js";
import { Modal } from "../../ui/dialog.js";
import { SearchSettings as Section, usageWords } from "./SearchSettings.js";

afterEach(cleanup);

const provider = (over: Partial<SearchProvider> & { id: string }): SearchProvider => ({
  label: over.id === "tavily" ? "Tavily" : "Brave Search",
  position: 1,
  state: "ready",
  searchesThisMonth: 0,
  keyNames: {
    secret: over.id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_SEARCH_API_KEY",
    env: over.id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_SEARCH_API_KEY",
  },
  ...over,
});

function setup(first: WebSearchSettings | Error, later?: WebSearchSettings) {
  let calls = 0;
  const api = {
    webSearch: {
      get: vi.fn(async () => {
        calls += 1;
        const now = calls === 1 || later === undefined ? first : later;
        if (now instanceof Error) throw now;
        return now;
      }),
    },
    vault: { set: vi.fn(async (name: string) => makeSecret({ name })) },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = { api, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <Modal onClose={() => {}} label="Configurações" className="">
        <Section title="Busca" titleId="t" />
      </Modal>
    </ServicesProvider>,
  );
  return api;
}

describe("Configurações > Busca", () => {
  it("shows the engines in the server's order, each with its state in plain words and the month's count", async () => {
    setup({
      enabled: true,
      providers: [
        provider({ id: "tavily", position: 1, state: "quota", searchesThisMonth: 1000 }),
        provider({ id: "brave", position: 2, state: "ready", searchesThisMonth: 1 }),
      ],
    });
    const group = await screen.findByTestId("search-providers");
    const rows = within(group).getAllByTestId(/^search-provider-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "search-provider-tavily",
      "search-provider-brave",
    ]);
    expect(screen.getByTestId("search-state-tavily").textContent).toBe("Cota do mês usada");
    expect(screen.getByTestId("search-usage-tavily").textContent).toContain("1000 buscas este mês");
    expect(screen.getByTestId("search-state-brave").textContent).toBe("Pronto");
    expect(screen.getByTestId("search-usage-brave").textContent).toContain("1 busca este mês");
  });

  it("says every state in words, with nothing technical on the screen", async () => {
    setup({
      enabled: true,
      providers: [
        provider({ id: "tavily", state: "no_key" }),
        provider({ id: "brave", position: 2, state: "key_rejected", retryInSeconds: 3600 }),
      ],
    });
    await screen.findByTestId("search-providers");
    expect(screen.getByTestId("search-state-tavily").textContent).toBe("Sem chave");
    expect(screen.getByTestId("search-state-brave").textContent).toBe("Chave não aceita");
    const text = document.body.textContent ?? "";
    for (const technical of ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "3600", "quota", "no_key"]) {
      expect(text).not.toContain(technical);
    }
    // With nothing ready, the bots are said to use the other engines.
    expect(screen.getByTestId("search-none-ready").textContent).toContain("Wikipédia");
  });

  it("adds a key through the vault: the steps, a secure field, the name kept out of sight, and the list is read again", async () => {
    const api = setup(
      { enabled: true, providers: [provider({ id: "tavily", state: "no_key" })] },
      {
        enabled: true,
        providers: [provider({ id: "tavily", state: "ready", searchesThisMonth: 0 })],
      },
    );
    fireEvent.click(await screen.findByTestId("search-key-tavily"));
    const dialog = await screen.findByRole("dialog", { name: "Chave do Tavily" });
    expect(within(dialog).getByTestId("secret-steps").textContent).toContain("mil buscas");
    expect(dialog.textContent).not.toContain("TAVILY_API_KEY");
    const field = within(dialog).getByTestId("secret-input") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "tvly-made-up-key-for-the-test" } });
    fireEvent.click(within(dialog).getByTestId("secret-write"));
    await waitFor(() =>
      expect(api.vault.set).toHaveBeenCalledWith("TAVILY_API_KEY", {
        value: "tvly-made-up-key-for-the-test",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("search-state-tavily").textContent).toBe("Pronto"),
    );
    expect(api.webSearch.get).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("search-key-tavily").textContent).toBe("Trocar a chave");
    // The key is gone from the screen once it was sent.
    expect(document.body.textContent).not.toContain("tvly-made-up-key-for-the-test");
  });

  it("an engine that is off has no button; with the search off there is one calm line", async () => {
    setup({
      enabled: true,
      providers: [provider({ id: "tavily", state: "off" })],
    });
    await screen.findByTestId("search-providers");
    expect(screen.queryByTestId("search-key-tavily")).toBeNull();
    expect(screen.getByTestId("search-state-tavily").textContent).toBe("Desligado");
    cleanup();
    setup({ enabled: false, providers: [] });
    expect(await screen.findByTestId("search-off")).toBeTruthy();
  });

  it("a server that does not answer is a friendly line, never its message", async () => {
    setup(new ApiError("internal_error", "boom: ECONNREFUSED 10.0.0.1", 500));
    expect(await screen.findByText("Não foi possível ler a busca")).toBeTruthy();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("counts in words", () => {
    expect(usageWords(0)).toBe("0 buscas este mês");
    expect(usageWords(1)).toBe("1 busca este mês");
    expect(usageWords(12)).toBe("12 buscas este mês");
  });
});
