import { expect, type Page, type Route, test } from "@playwright/test";
// The gallery of the server and the in-repo fake OAuth server, from the built packages (the app
// does not depend on them; `pnpm exec tsc -b` builds them, as for the harness).
import { CONNECTOR_CATALOG } from "../../../packages/connectors/dist/index.js";
import {
  type FakeOAuthServer,
  startFakeOAuthMcp,
} from "../../../packages/connectors/dist/testing/index.js";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openApp } from "./helpers.js";

// The connectors screen against a real server (docs/DESIGN.md §5d): the list is the server's
// gallery, plus one entry that points at the fake OAuth server (as the backend tests do it). The
// browser of the test is "the system browser": the app opens the login page in a new tab, the fake
// authorization server approves at once and sends it back to the server's loopback callback.

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

test.describe("the connectors screen, wired to the server's gallery", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  let fake: FakeOAuthServer;
  test.beforeAll(async () => {
    fake = await startFakeOAuthMcp();
    const notion = CONNECTOR_CATALOG.find((e) => e.id === "notion");
    if (notion === undefined) throw new Error("the gallery has no notion");
    world = await startWorld({
      connectorCatalog: [
        ...CONNECTOR_CATALOG,
        {
          ...notion,
          id: FAKE_ID,
          name: "Serviço de teste",
          description: "Um servidor MCP falso, com OAuth, só para os testes.",
          source: fake.mcpUrl,
          license: "MIT",
          icon: null,
          transport: { kind: "http", url: fake.mcpUrl, headers: {} },
          egressHosts: ["127.0.0.1"],
          notes: [],
        },
      ],
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
    await expect(page.getByTestId("connector-item")).toHaveCount(served.length);
    const drawn = await page
      .getByTestId("connector-item")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-plugin")));
    expect([...drawn].sort()).toEqual([...served].sort());
    // within a section, the server's order
    const dev = await page
      .locator(
        '[data-testid="connectors-section"][data-category="Desenvolvimento"] [data-testid="connector-item"]',
      )
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-plugin")));
    expect(dev).toEqual(served.filter((id) => ["github", "figma", "stackoverflow"].includes(id)));
    // the entry the app has no look for: the plug, in Outros
    await expect(row(page, FAKE_ID).locator("svg.lucide-plug")).toHaveCount(1);
    // "a confirmar": no Conectar, the reason in the tag
    await expect(row(page, "stackoverflow").getByTestId("connector-connect")).toHaveCount(0);
    await expect(row(page, "stackoverflow").getByTestId("connector-state")).toHaveText(
      "A confirmar",
    );
    await page.screenshot({ path: `${SHOTS}/24-conectores-lista.png` });
    await page.screenshot({ path: `${SHOTS}/24-conectores-lista-inteira.png`, fullPage: true });
    await row(page, "figma").locator("button").first().click();
    await expect(page.getByTestId("connector-page")).toBeVisible();
    await expect(page.getByTestId("connector-notes")).toContainText("6 chamadas por mês");
    await page.screenshot({ path: `${SHOTS}/24a-conectores-pagina.png` });
    await page.keyboard.press("Escape");
    await row(page, "google-workspace").locator("button").first().click();
    await expect(page.getByTestId("connector-unverified")).toBeVisible();
    await expect(page.getByTestId("connector-main")).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/24b-conectores-a-confirmar.png` });
  });

  test("OAuth: Conectar, 'Aguardando login…', the browser reaches the callback, Conectado; then Desconectar", async ({
    page,
    context,
  }) => {
    await openApp(page, world);
    await openConnectors(page);
    // Hold the authorization page until the waiting state is on screen (and photographed).
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route(`${fake.issuer}/authorize**`, async (route: Route) => {
      await held;
      await route.continue();
    });
    const popup = page.waitForEvent("popup");
    await row(page, FAKE_ID).getByTestId("connector-connect").click();
    await expect(page.getByTestId("connector-waiting")).toContainText(
      "Aguardando login no navegador…",
    );
    await expect(state(page)).toHaveText("Aguardando login…");
    await page.screenshot({ path: `${SHOTS}/24c-conectores-aguardando-login.png` });
    // The browser goes on: the fake approves and sends it to the server's loopback callback.
    release();
    const tab = await popup;
    await tab.waitForLoadState();
    await expect(state(page)).toHaveText("Conectado");
    await expect(page.getByTestId("connector-waiting")).toHaveCount(0);
    expect(tab.url().includes("/callback?")).toBe(true);
    await tab.close();
    expect((await world.api.connectors.get(FAKE_ID)).enabled).toBe(true);
    await page.screenshot({ path: `${SHOTS}/24d-conectores-conectado.png` });
    await context.unroute(`${fake.issuer}/authorize**`);

    // Desconectar asks first.
    await page.getByTestId("connector-main").click();
    await expect(
      page.getByRole("dialog", { name: "Desconectar o Serviço de teste?" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/24e-conectores-desconectar.png` });
    await page.getByTestId("connector-disconnect").click();
    await expect(state(page)).toHaveText("Precisa de login");
    expect((await world.api.connectors.get(FAKE_ID)).enabled).toBe(false);
    expect(fake.revocations.length).toBeGreaterThan(0);
  });

  test("a server the browser cannot reach (a VPS): the address the browser stopped at completes the login", async ({
    page,
    context,
  }) => {
    await openApp(page, world);
    await openConnectors(page);
    // The browser of a VPS: the authorization server answers, but the callback never loads.
    let landed = "";
    await context.route(`${fake.issuer}/authorize**`, async (route: Route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      landed = answer.headers().location ?? "";
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p>sem retorno</p>" });
    });
    const popup = page.waitForEvent("popup");
    await row(page, FAKE_ID).getByTestId("connector-connect").click();
    const paste = page.getByTestId("connector-paste");
    await expect(paste).toContainText("Cole aqui o endereço em que o navegador parou");
    await (await popup).close();
    await expect.poll(() => landed).toContain("/callback?");
    await paste.getByRole("textbox").fill(landed);
    await page.screenshot({ path: `${SHOTS}/24f-conectores-colar-endereco.png` });
    await paste.getByTestId("connector-complete").click();
    await expect(state(page)).toHaveText("Conectado");
    await context.unroute(`${fake.issuer}/authorize**`);
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
    await page.screenshot({ path: `${SHOTS}/24g-conectores-token.png` });
    await dialog.getByTestId("secret-input").fill(VALUE);
    await dialog.getByTestId("secret-write").click();
    await expect(dialog).toHaveCount(0);
    await expect(state(page)).toHaveText("Conectado");
    await expect(page.getByTestId("connector-main")).toHaveText("Trocar o token");
    expect((await world.api.vault.list()).map((s) => s.name)).toContain("GITHUB_TOKEN");
    expect((await world.api.connectors.get("github")).enabled).toBe(true);
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
