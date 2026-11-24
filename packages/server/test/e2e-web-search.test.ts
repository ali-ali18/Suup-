import { generateKeyText } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, useWorld } from "./world.js";

// The general search engines through the API (Settings > Busca): which have a key (in the
// environment or in the vault), in the configured order, with the month's count. Made-up keys only;
// nothing here touches the internet (no search is made).
const BRAVE_KEY = "BSA-made-up-key-for-this-test-0001";
const TAVILY_KEY = "tvly-made-up-key-for-this-test-0002";

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("web search through the API"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({
      scripts: { roteiro: { agent: [] } },
      config: {
        vault: { keyEnv: "SERVER_TEST_VAULT_KEY" },
        web: {
          search: {
            engines: ["wikipedia", "tavily", "brave"],
            general: { order: ["brave", "tavily"] },
          },
          reader: { enabled: false },
        },
      },
      env: { SERVER_TEST_VAULT_KEY: generateKeyText(), BRAVE_SEARCH_API_KEY: BRAVE_KEY },
    });

    it("lists the engines in the configured order, with where each stands, and never a key", async () => {
      const { api } = w.started;
      const first = await api.webSearch.get();
      expect(first).toMatchObject({
        enabled: true,
        providers: [
          { id: "brave", label: "Brave Search", position: 1, state: "ready", searchesThisMonth: 0 },
          { id: "tavily", label: "Tavily", position: 2, state: "no_key", searchesThisMonth: 0 },
        ],
      });
      // How the gallery shows each engine, from the declared catalog (never a connector).
      expect(first.providers.map((p) => [p.id, p.plugin?.category])).toEqual([
        ["brave", "Pesquisa na web"],
        ["tavily", "Pesquisa na web"],
      ]);
      expect(first.providers[1]?.plugin?.keySteps[0]).toContain("Tavily");
      expect(first.providers[1]?.keyNames).toEqual({
        secret: "TAVILY_API_KEY",
        env: "TAVILY_API_KEY",
      });
      // The key goes in through the vault, and the next read sees it.
      await api.vault.set("TAVILY_API_KEY", { value: TAVILY_KEY });
      const second = await api.webSearch.get();
      expect(second.providers.map((p) => `${p.id}:${p.state}`)).toEqual([
        "brave:ready",
        "tavily:ready",
      ]);
      const text = JSON.stringify([first, second]);
      expect(text).not.toContain(TAVILY_KEY);
      expect(text).not.toContain(BRAVE_KEY);
    });
  },
);
