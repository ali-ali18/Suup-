import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { freshBot, openApp, openSettings } from "./helpers.js";

// Configurações > Busca, with a real server: a short pointer. The general search engines in their
// order, each with its state in plain words and an "Abrir" to the plugin's page, where the key is
// added through the vault (never shown, never in the screen).

const KEY = "tvly-E2E-made-up-key-0000000000";

test.describe("settings: web search", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the queue in its order, no key yet; adding one makes the engine ready, and nothing technical shows", async ({
    page,
  }) => {
    await freshBot(world, "Usuário da busca");
    await openApp(page, world);
    await openSettings(page, "Busca");
    const rows = page.getByTestId("search-providers").locator('[data-testid^="search-provider-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "search-provider-tavily");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "search-provider-brave");
    await expect(page.getByTestId("search-state-tavily")).toHaveText("Sem chave");
    await expect(page.getByTestId("search-state-brave")).toHaveText("Sem chave");
    await expect(page.getByTestId("search-usage-tavily")).toContainText("0 buscas este mês");
    await expect(page.getByTestId("search-none-ready")).toContainText("Wikipédia");
    // Nothing technical: no variable, no secret name, no code.
    const screen = page.getByTestId("settings-screen");
    for (const technical of ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "no_key", "quota"]) {
      await expect(screen).not.toContainText(technical);
    }

    // No key control here: "Abrir" goes to the plugin's page, where the key is added.
    await expect(page.getByTestId("search-key-tavily")).toHaveCount(0);
    await page.getByTestId("search-open-tavily").click();
    await expect(page.getByTestId("settings-screen")).toHaveCount(0);
    await page.getByTestId("search-key").click();
    const dialog = page.getByRole("dialog", { name: "Chave do Tavily" });
    await expect(dialog.getByTestId("secret-steps")).toContainText("mil buscas");
    await expect(dialog).not.toContainText("TAVILY_API_KEY");
    const input = dialog.getByTestId("secret-input");
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(KEY);
    await dialog.getByTestId("secret-write").click();
    await expect(dialog).toHaveCount(0);
    await openSettings(page, "Busca");

    // The server read the key from the vault: ready, and the second engine is still without one.
    await expect(page.getByTestId("search-state-tavily")).toHaveText("Pronto");
    await expect(page.getByTestId("search-state-brave")).toHaveText("Sem chave");
    await expect(page.getByTestId("search-key-tavily")).toHaveCount(0);
    await expect(page.getByTestId("search-none-ready")).toHaveCount(0);
    await expect(screen).not.toContainText(KEY);
    const providers = await world.api.webSearch.get();
    expect(providers.providers.map((p) => `${p.id}:${p.state}`)).toEqual([
      "tavily:ready",
      "brave:no_key",
    ]);
    expect(JSON.stringify(providers)).not.toContain(KEY);
  });
});
