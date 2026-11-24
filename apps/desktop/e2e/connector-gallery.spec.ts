import { expect, type Page, test } from "@playwright/test";
// The gallery of the server and the in-repo fake OAuth server, from the built packages (the app
// does not depend on them; `pnpm exec tsc -b` builds them, as for the harness).
import { CONNECTOR_CATALOG } from "../../../packages/connectors/dist/index.js";
import {
  type FakeOAuthServer,
  startFakeOAuthMcp,
} from "../../../packages/connectors/dist/testing/index.js";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openApp } from "./helpers.js";
import { installTauriMock } from "./tauri-mock.js";

// The connectors screen against a real server (docs/DESIGN.md §5d): the list is the server's
// gallery, plus one entry that points at the fake OAuth server (as the backend tests do it). The
// OAuth tests run in the Tauri shell played by `tauri-mock.ts`, in an EXPLICIT mode: "neste
// computador" (the login comes back to the server's loopback) or "minha VPS" (with its public
// address, or without one). The test plays the system browser: it opens what the app asked the
// shell to open, the fake authorization server approves at once and sends it back to the server.
// There is never an address to paste (the owner, 23/11/2026).

const SHOTS = "screenshots/1440x900@2x";
const FAKE_ID = "teste-oauth";
const VALUE = "ghp_E2E_made_up_token_for_the_gallery_7c1d";

async function openConnectors(page: Page): Promise<void> {
  await page.getByTestId("owner-menu").click();
  await page.getByRole("menuitem", { name: "Conectores" }).click();
  await expect(page.getByTestId("connectors-screen")).toBeVisible();
}

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="connector-item"][data-plugin="${id}"]`);
const state = (page: Page) => page.getByTestId("connector-page").getByTestId("connector-state");

/** The app on "neste computador" (the shell plays the embedded server: the test's server). */
async function openLocal(page: Page, world: World): Promise<void> {
  await installTauriMock(page, world, {
    isolation: { mode: "docker", reason: null, detail: null },
  });
  await page.goto(world.appUrl);
  await page.getByTestId("choose-local").click();
  await page.getByTestId("key-later").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

/** The app on "minha VPS", already connected to the test's server. */
async function openVps(page: Page, world: World): Promise<void> {
  await installTauriMock(page, world, { vps: true });
  await page.goto(world.appUrl);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

/** What the app asked the system browser to open, once it did. */
async function opened(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => (window as { __openedUrls?: string[] }).__openedUrls?.length))
    .toBeGreaterThan(0);
  return page.evaluate(
    () => (window as unknown as { __openedUrls: string[] }).__openedUrls[0] ?? "",
  );
}

/** The fake entry, pointing at the fake OAuth server. */
function fakeEntry(fake: FakeOAuthServer) {
  const notion = CONNECTOR_CATALOG.find((e) => e.id === "notion");
  if (notion === undefined) throw new Error("the gallery has no notion");
  return {
    ...notion,
    id: FAKE_ID,
    name: "Serviço de teste",
    description: "Um servidor MCP falso, com OAuth, só para os testes.",
    source: fake.mcpUrl,
    license: "MIT",
    icon: null,
    transport: { kind: "http" as const, url: fake.mcpUrl, headers: {} },
    egressHosts: ["127.0.0.1"],
    notes: [],
  };
}

/**
 * The GitHub entry pointed at a closed local port: the test never depends on whether the machine it
 * runs on reaches the internet (on CI it does, here it does not). Connecting with a token then fails
 * to list the tools the same way everywhere.
 */
function offlineGithub(
  entry: (typeof CONNECTOR_CATALOG)[number],
): (typeof CONNECTOR_CATALOG)[number] {
  const transport = entry.transport;
  if (entry.id !== "github" || transport === null || transport.kind !== "http") return entry;
  return {
    ...entry,
    transport: { ...transport, url: "http://127.0.0.1:9/mcp" },
    egressHosts: ["127.0.0.1"],
  };
}

test.describe("the connectors screen, wired to the server's gallery", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  let fake: FakeOAuthServer;
  test.beforeAll(async () => {
    fake = await startFakeOAuthMcp();
    world = await startWorld({
      connectorCatalog: [...CONNECTOR_CATALOG.map(offlineGithub), fakeEntry(fake)],
    });
  });
  test.afterAll(async () => {
    await world?.stop();
    await fake?.close();
  });

  test("draws exactly the server's gallery, in its order, with the look by id", async ({
    page,
  }) => {
    await openApp(page, world);
    await openConnectors(page);
    const served = (await world.api.connectorCatalog.list()).map((i) => i.entry.id);
    // The search engines of the queue are plugins of the gallery too ("Pesquisa na web").
    const engines = (await world.api.webSearch.get()).providers.map((p) => p.id);
    expect(engines).toEqual(["tavily", "brave"]);
    await expect(page.getByTestId("connector-item")).toHaveCount(served.length + engines.length);
    const drawn = await page
      .getByTestId("connector-item")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-plugin")));
    expect([...drawn].sort()).toEqual([...served, ...engines].sort());
    // within a section, the server's order
    const dev = await page
      .locator(
        '[data-testid="connectors-section"][data-category="Desenvolvimento"] [data-testid="connector-item"]',
      )
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-plugin")));
    expect(dev).toEqual(served.filter((id) => ["github", "figma", "stackoverflow"].includes(id)));
    // the entry the app has no look for: the plug, in Outros
    await expect(row(page, FAKE_ID).locator("svg.lucide-plug")).toHaveCount(1);
    // "em breve": no Conectar
    await expect(row(page, "stackoverflow").getByTestId("connector-connect")).toHaveCount(0);
    await expect(row(page, "stackoverflow").getByTestId("connector-state")).toHaveText("Em breve");
    await page.screenshot({ path: `${SHOTS}/24-conectores-lista.png` });
    await page.screenshot({ path: `${SHOTS}/24-conectores-lista-inteira.png`, fullPage: true });
    await row(page, "figma").locator("button").first().click();
    await expect(page.getByTestId("connector-page")).toBeVisible();
    await expect(page.getByTestId("connector-notes")).toContainText(
      "No plano grátis do Figma são 6 usos por mês.",
    );
    // nothing technical on the page: no address, licence, hosts or date
    for (const technical of ["mcp.figma.com", "Licença", "Fala com", "Conferido em"]) {
      await expect(page.getByTestId("connector-page")).not.toContainText(technical);
    }
    await page.screenshot({ path: `${SHOTS}/24a-conectores-pagina.png` });
    await page.keyboard.press("Escape");
    await row(page, "google-workspace").locator("button").first().click();
    await expect(page.getByTestId("connector-connection-text")).toHaveText(
      "Ainda estamos preparando um jeito seguro de ligar o Google aos seus bots.",
    );
    await expect(page.getByTestId("connector-main")).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/24b-conectores-a-confirmar.png` });
  });

  test("OAuth on this computer: Conectar, 'Aguardando login…', the browser comes back to the loopback, Conectado; then Desconectar", async ({
    page,
    context,
  }) => {
    await openLocal(page, world);
    await openConnectors(page);
    await row(page, FAKE_ID).getByTestId("connector-connect").click();
    await expect(page.getByTestId("connector-waiting")).toContainText(
      "Aguardando login no navegador…",
    );
    await expect(state(page)).toHaveText("Aguardando login…");
    // the browser comes back by itself: nothing to paste, ever
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("Cole")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/24c-conectores-aguardando-login.png` });
    // The system browser: the fake approves and sends it to the server's loopback callback.
    const url = await opened(page);
    const tab = await context.newPage();
    await tab.goto(url);
    await expect(state(page)).toHaveText("Conectado");
    await expect(page.getByTestId("connector-waiting")).toHaveCount(0);
    expect(tab.url().startsWith("http://127.0.0.1:")).toBe(true);
    expect(tab.url().includes("/callback?")).toBe(true);
    await expect(tab.locator("body")).toContainText("Login feito");
    await tab.close();
    expect((await world.api.connectors.get(FAKE_ID)).enabled).toBe(true);
    // The login tokens are the connector's own: the Cofre never lists them.
    expect((await world.api.vault.list()).filter((s) => s.name.includes("OAUTH"))).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/24d-conectores-conectado.png` });

    // Desconectar asks first.
    await page.getByTestId("connector-main").click();
    await expect(
      page.getByRole("dialog", { name: "Desconectar o Serviço de teste?" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/24e-conectores-desconectar.png` });
    await page.getByTestId("connector-disconnect").click();
    await expect(state(page)).toHaveText("Precisa entrar");
    expect((await world.api.connectors.get(FAKE_ID)).enabled).toBe(false);
    expect(fake.revocations.length).toBeGreaterThan(0);
  });

  test("a VPS without a public address: no login is offered, one friendly sentence says why; tokens still work", async ({
    page,
  }) => {
    await openVps(page, world);
    await openConnectors(page);
    await expect(row(page, FAKE_ID)).toBeVisible();
    await expect(row(page, FAKE_ID).getByTestId("connector-connect")).toHaveCount(0);
    await expect(row(page, "github").getByTestId("connector-connect")).toHaveCount(1);
    await row(page, FAKE_ID).locator("button").first().click();
    await expect(page.getByTestId("connector-connection-text")).toHaveText(
      "Para conectar pelo login, a sua VPS precisa ter o endereço público configurado.",
    );
    await expect(page.getByTestId("connector-main")).toBeDisabled();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/24f-conectores-vps-sem-endereco.png` });
  });

  test("a token: Conectar opens the secure form of the vault, then the entry is on", async ({
    page,
  }) => {
    await openApp(page, world);
    await openConnectors(page);
    await row(page, "github").getByRole("button", { name: "Conectar GitHub" }).click();
    const dialog = page.getByRole("dialog", { name: "Token do GitHub" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("secret-steps")).toContainText("Fine-grained tokens");
    await expect(dialog.getByTestId("secret-input")).toHaveAttribute("type", "password");
    // the name the token is kept under is internal: not on the form
    await expect(dialog).not.toContainText("GITHUB_TOKEN");
    await page.screenshot({ path: `${SHOTS}/24g-conectores-token.png` });
    await dialog.getByTestId("secret-input").fill(VALUE);
    await dialog.getByTestId("secret-write").click();
    await expect(dialog).toHaveCount(0);
    // The token turns it on, and turning it on lists its tools at once. The entry points at a closed
    // local port (offlineGithub), so the listing fails: the page says so plainly and offers to try again.
    await expect.poll(async () => (await world.api.connectors.get("github")).enabled).toBe(true);
    await expect(state(page)).toHaveText("Não conectou");
    await expect(page.getByTestId("plugin-unlisted")).toContainText(
      "Ainda não consegui ver as ferramentas",
    );
    await expect(page.getByTestId("plugin-retry")).toHaveText("Tentar de novo");
    expect((await world.api.vault.list()).map((s) => s.name)).toContain("GITHUB_TOKEN");
    // the value is nowhere on the page
    expect(await page.content()).not.toContain(VALUE);
    // back to the list: "Meus conectores" shows what is connected
    await page.getByTestId("connector-back").click();
    await expect(
      page.getByTestId("connectors-mine").locator('[data-testid="connectors-mine-icon"]'),
    ).toHaveCount(
      (await world.api.connectorCatalog.list()).filter((i) => i.status === "connected").length,
    );
    await page.screenshot({ path: `${SHOTS}/24h-conectores-meus-conectores.png` });
  });
});

// A VPS with its public address (here its own loopback address, which the MCP rule allows; in
// production an HTTPS one): the login comes back straight to the server's `/oauth/callback`.
test.describe("OAuth on a VPS with its public address", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  let fake: FakeOAuthServer;
  test.beforeAll(async () => {
    fake = await startFakeOAuthMcp();
    world = await startWorld({
      connectorCatalog: [...CONNECTOR_CATALOG, fakeEntry(fake)],
      publicAddress: true,
    });
  });
  test.afterAll(async () => {
    await world?.stop();
    await fake?.close();
  });

  test("Conectar, the browser comes back to the server's own address, Conectado; nothing to paste", async ({
    page,
    context,
  }) => {
    await openVps(page, world);
    await openConnectors(page);
    await row(page, FAKE_ID).getByTestId("connector-connect").click();
    await expect(page.getByTestId("connector-waiting")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    const url = await opened(page);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${world.serverUrl}/oauth/callback`);
    const tab = await context.newPage();
    await tab.goto(url);
    await expect(tab.locator("body")).toContainText("Login feito");
    expect(tab.url().startsWith(`${world.serverUrl}/oauth/callback?`)).toBe(true);
    await tab.close();
    await expect(state(page)).toHaveText("Conectado");
    expect((await world.api.connectors.get(FAKE_ID)).enabled).toBe(true);
  });
});
