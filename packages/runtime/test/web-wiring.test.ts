import { describe, expect, it } from "vitest";
import { createSearchKeys } from "../src/web/search-keys.js";
import { createWebWiring } from "../src/web/wiring.js";

// A key that exists only in these tests (never a real one).
const FAKE_KEY = "tvly-test-key-not-real-0000";

describe("web wiring", () => {
  it("starts nothing until a tool asks, and the doctor does not start it", async () => {
    const wiring = createWebWiring({ reader: { enabled: false } });
    expect(await wiring.status()).toMatchObject({
      started: false,
      search: "pending",
      reader: "off",
    });
    expect(wiring.access.readerEnabled).toBe(false);
    await wiring.close();
  });

  it("with no key the general engines are skipped, and the answer says the general search is not set up", async () => {
    const wiring = createWebWiring({
      search: { engines: ["tavily", "brave"] },
      reader: { enabled: false },
    });
    const out = await wiring.access.search({ query: "test", limit: 3 });
    expect(out).toMatchObject({
      ok: true,
      hits: [],
      engines: [],
      generalUnavailable: { cause: "no_key" },
    });
    expect(await wiring.searchProviders()).toMatchObject([
      { id: "tavily", position: 1, state: "no_key", searchesThisMonth: 0 },
      { id: "brave", position: 2, state: "no_key", searchesThisMonth: 0 },
    ]);
    await wiring.close();
  });

  it("lists the providers in the configured order, with their states, and turned-off ones last", async () => {
    const keys = createSearchKeys({
      env: { MY_BRAVE: FAKE_KEY },
      vault: { status: () => ({ ok: false }) } as never,
      settings: (id) => (id === "brave" ? { apiKeyEnv: "MY_BRAVE" } : undefined),
    });
    const wiring = createWebWiring(
      { search: { engines: ["wikipedia", "brave"], general: { order: ["brave", "tavily"] } } },
      { searchKeys: keys },
    );
    expect(await wiring.searchProviders()).toMatchObject([
      { id: "brave", position: 1, state: "ready", keyNames: { env: "MY_BRAVE" } },
      { id: "tavily", position: 2, state: "off" },
    ]);
    await wiring.close();
  });

  it("for an evaluation Brave is left out (its terms forbid using its results to evaluate AI), and the rest of the queue stays", async () => {
    const keys = createSearchKeys({
      env: { BRAVE_SEARCH_API_KEY: FAKE_KEY, TAVILY_API_KEY: FAKE_KEY },
      vault: { status: () => ({ ok: false }) } as never,
      settings: () => undefined,
    });
    const wiring = createWebWiring(
      { search: { engines: ["wikipedia", "tavily", "brave"] }, reader: { enabled: false } },
      { searchKeys: keys },
    );
    expect(await wiring.searchProviders()).toMatchObject([
      { id: "tavily", state: "ready" },
      { id: "brave", state: "ready" },
    ]);
    await wiring.restrictForEvaluation();
    expect(await wiring.searchProviders()).toMatchObject([
      { id: "tavily", state: "ready" },
      { id: "brave", state: "off" },
    ]);
    // Even the default list (nothing in the configuration) loses it.
    const plain = createWebWiring({ reader: { enabled: false } }, { searchKeys: keys });
    await plain.restrictForEvaluation();
    expect((await plain.searchProviders()).find((p) => p.id === "brave")?.state).toBe("off");
    await wiring.close();
    await plain.close();
  });

  it("says search is off when the configuration turns it off, and reading is off when the reader is", async () => {
    const wiring = createWebWiring({ search: { enabled: false }, reader: { enabled: false } });
    expect(await wiring.access.search({ query: "x y" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await wiring.access.read({ url: "https://example.com/" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await wiring.searchProviders()).toEqual([]);
    await wiring.close();
  });

  it("reads an HTML page already downloaded, with no network", async () => {
    const wiring = createWebWiring({ search: { enabled: false }, reader: { enabled: false } });
    const page = await wiring.access.extract({
      html: "<html><body><p>Just a short note.</p></body></html>",
      url: "https://example.com/n",
    });
    expect(page?.markdown).toBe("Just a short note.");
    await wiring.close();
  });
});
