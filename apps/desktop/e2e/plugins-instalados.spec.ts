import { expect, type Page, test } from "@playwright/test";
import {
  DATABASE_URL,
  fakeMcpCommand,
  SCRIPTS,
  SKIP_REASON,
  startWorld,
  type World,
} from "./harness.js";
import { freshBot, openApp, openPluginPage, openSettings, selectBot, send } from "./helpers.js";
import { installTauriMock } from "./tauri-mock.js";

// Owner, 24/11/2026: Settings > Conectores is the "Instalado" list, a plugin is managed on ITS page,
// Tavily and Brave are plugins ("Pesquisa na web"), and the bot hands over cards, never directions.

const SHOTS = "screenshots/plugins-antes-depois";
const usage = { inputTokens: 1000, outputTokens: 100 };
const step = <T extends object>(s: T) => ({ ...s, usage });
const KEY = "tvly-E2E-made-up-key-0000000000";

/** Extra cases of the scripted bot: the hand-over cards. */
const roteiro = {
  ...SCRIPTS.roteiro,
  cases: [
    {
      whenObjectiveContains: "CASE-HANDOVER-GRANT",
      agent: [
        step({
          calls: [{ name: "show_connect_card", args: { connector: "fake", action: "grant" } }],
        }),
        step({ text: "Mostrei o cartão para liberar o conector." }),
      ],
    },
    {
      whenObjectiveContains: "CASE-HANDOVER-LINK",
      agent: [
        step({
          calls: [
            {
              name: "show_connect_card",
              args: {
                connector: "composio",
                app: "Google Agenda",
                action: "authorize_app",
                url: "https://connect.composio.dev/link/lk_E2E?token=nao-mostrar",
              },
            },
          ],
        }),
        step({ text: "Aqui está o cartão para autorizar." }),
      ],
    },
    {
      whenObjectiveContains: "CASE-HANDOVER-EVIL",
      agent: [
        step({
          calls: [
            {
              name: "show_connect_card",
              args: {
                connector: "composio",
                action: "authorize_app",
                url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
              },
            },
          ],
        }),
        step({ text: "Tentei mostrar o link." }),
      ],
    },
    {
      whenObjectiveContains: "CASE-PROPOSE",
      agent: [
        step({
          calls: [
            {
              name: "propose_connector",
              args: { connector: "notion", reason: "ler suas páginas" },
            },
          ],
        }),
        step({ text: "Pedi para instalar o Notion." }),
      ],
    },
    ...SCRIPTS.roteiro.cases,
  ],
};

async function installFake(world: World): Promise<void> {
  await world.api.connectors.create({
    name: "fake",
    description: "Servidor de teste",
    transport: { kind: "stdio", ...fakeMcpCommand() },
    scope: "read_write",
  });
}

test.describe("plugins: the installed list, the plugin's page and the search engines", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: { ...SCRIPTS, roteiro } });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("Settings > Conectores shows the installed grid; a row opens its page; connect, turn off and remove happen there", async ({
    page,
  }) => {
    await openApp(page, world);
    await installFake(world);
    await world.api.connectorCatalog.install("notion");
    await openSettings(page, "Conectores");
    const grid = page.getByTestId("installed-list");
    await expect(grid.getByTestId("installed-item")).toHaveCount(2);
    // Notion (from the catalog): its friendly name, a "Conectar" pill (it needs a login); the one
    // added by hand keeps its own name.
    const notion = grid.locator('[data-plugin="notion"]');
    await expect(notion).toContainText("Notion");
    await expect(notion.getByTestId("installed-connect")).toHaveText("Conectar");
    const fake = grid.locator('[data-plugin="fake"]');
    await expect(fake.getByTestId("installed-state")).toHaveText("Conectado");
    // Nothing to switch or open in the list itself.
    await expect(page.getByRole("switch")).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/depois-1-config-conectores.png` });
    // A row opens the page of that plugin (Settings closes).
    await notion.locator("button").first().click();
    await expect(page.getByTestId("settings-screen")).toHaveCount(0);
    await expect(page.getByTestId("connector-page")).toHaveAttribute("data-plugin", "notion");
    await expect(page.getByTestId("connector-state")).toHaveText("Precisa entrar");
    // Its page has what the list no longer has: on or off, the bots, the tools, removing it.
    const manage = page.getByTestId("connector-row").filter({ hasText: "notion" });
    await expect(manage.getByTestId("plugin-no-bots")).toBeVisible();
    await expect(manage.getByTestId("plugin-unlisted")).toBeVisible();
    await expect(manage.getByRole("switch", { name: "notion: ligado" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/depois-2-pagina-notion.png` });
    // "Mostrar todos" goes to the whole gallery; the fake one's page: switch off and on, then remove.
    await page.getByTestId("connector-back").click();
    await openPluginPage(page, "fake");
    const row = page.getByTestId("connector-row").filter({ hasText: "fake" });
    const toggle = row.getByRole("switch", { name: "fake: ligado" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await world.api.connectors.get("fake")).enabled).toBe(false);
    await row.getByTestId("connector-delete").click();
    await page.getByTestId("connector-delete-confirm").click();
    await expect(page.getByTestId("connectors-screen")).toBeVisible();
    await openSettings(page, "Conectores");
    await expect(page.getByTestId("installed-item")).toHaveCount(1);
    await page.getByTestId("installed-show-all").click();
    await expect(page.getByTestId("connectors-screen")).toBeVisible();
    await expect(page.getByTestId("settings-screen")).toHaveCount(0);
    await world.api.connectors.remove("notion");
  });

  test("Tavily and Brave are plugins in 'Pesquisa na web'; the page adds a key through the vault and the plugin becomes installed", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Conectores");
    await page.getByTestId("installed-show-all").click();
    const section = page.locator(
      '[data-testid="connectors-section"][data-category="Pesquisa na web"]',
    );
    // Tavily and Brave (engines of the queue) and Firecrawl (a connector of the gallery, owner 24/11/2026).
    await expect(section.getByTestId("connector-item")).toHaveCount(3);
    const entry = (id: string) =>
      section.locator(`[data-testid="connector-item"][data-plugin="${id}"]`);
    await expect(entry("tavily")).toContainText("Tavily");
    await expect(entry("brave")).toContainText("Brave Search");
    await expect(entry("firecrawl")).toContainText("Firecrawl");
    await expect(entry("firecrawl").locator("img[data-logo='firecrawl']")).toHaveCount(1);
    // Not installed yet: no key.
    await openSettings(page, "Conectores");
    await expect(page.locator('[data-testid="installed-item"][data-plugin="tavily"]')).toHaveCount(
      0,
    );
    await page.getByTestId("installed-show-all").click();
    await entry("tavily").locator("button").first().click();
    await expect(page.getByTestId("search-plugin-state")).toHaveText("Sem chave");
    await expect(page.getByTestId("search-plugin-usage")).toContainText("0 buscas este mês");
    await expect(page.getByTestId("search-plugin-queue")).toContainText("1º da fila");
    await page.screenshot({ path: `${SHOTS}/depois-3-pagina-tavily.png` });
    await page.getByTestId("search-key").click();
    const dialog = page.getByRole("dialog", { name: "Chave do Tavily" });
    await expect(dialog.getByTestId("secret-steps")).toContainText("mil buscas");
    await expect(dialog).not.toContainText("TAVILY_API_KEY");
    const input = dialog.getByTestId("secret-input");
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(KEY);
    await dialog.getByTestId("secret-write").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("search-plugin-state")).toHaveText("Pronto");
    await expect(page.getByTestId("connector-page")).not.toContainText(KEY);
    expect((await world.api.webSearch.get()).providers.map((p) => `${p.id}:${p.state}`)).toEqual([
      "tavily:ready",
      "brave:no_key",
    ]);
    // Installed now; Settings > Busca is a pointer (no key control) to the same page.
    await openSettings(page, "Conectores");
    const installed = page.locator('[data-testid="installed-item"][data-plugin="tavily"]');
    await expect(installed.getByTestId("installed-state")).toHaveText("Pronto");
    await page.getByRole("tab", { name: "Busca" }).click();
    await expect(page.getByTestId("search-state-tavily")).toHaveText("Pronto");
    await expect(page.getByTestId("search-key-tavily")).toHaveCount(0);
    await page.getByTestId("search-open-brave").click();
    await expect(page.getByTestId("connector-page")).toHaveAttribute("data-plugin", "brave");
    await expect(page.getByTestId("search-key")).toHaveText("Adicionar chave");
    await world.api.vault.remove("TAVILY_API_KEY");
  });

  test("a bot hands over a card: the connector is installed but not given to it, and the owner fixes it in one click", async ({
    page,
  }) => {
    await freshBot(world, "Entregador");
    await installFake(world);
    await openApp(page, world);
    await selectBot(page, "Entregador");
    await send(page, "CASE-HANDOVER-GRANT preciso do conector");
    const card = page.getByTestId("connect-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("connect-card-status")).toHaveText(
      "Conectado · Entregador ainda sem acesso",
    );
    await expect(card.getByTestId("connect-card-note")).toHaveText(
      "O Entregador sempre pergunta antes de fazer alterações. Desconecte quando quiser.",
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/depois-4-cartao-no-chat.png` });
    await card.getByTestId("connect-card-primary").click();
    await expect(card.getByTestId("connect-card-status")).toHaveText(
      "Conectado · Entregador pode usar",
    );
    await expect(card.getByTestId("connect-card-primary")).toHaveCount(0);
    const bot = (await world.api.bots.list()).find((b) => b.name === "Entregador");
    expect((await world.api.connectors.get("fake")).grants).toEqual([
      { botId: bot?.id, all: true, tools: [] },
    ]);
    // "Gerenciar" opens the plugin's page.
    await card.getByTestId("connect-card-manage").click();
    await expect(page.getByTestId("connector-page")).toHaveAttribute("data-plugin", "fake");
    await world.api.connectors.remove("fake");
  });

  test("a Composio authorize link is a card: a button, no address on screen; a link to another host is refused", async ({
    page,
  }) => {
    await freshBot(world, "Autorizador");
    await world.api.connectorCatalog.install("composio");
    await installTauriMock(page, world, {
      isolation: { mode: "docker", reason: null, detail: null },
    });
    await page.goto(world.appUrl);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("key-later").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await selectBot(page, "Autorizador");
    await send(page, "CASE-HANDOVER-LINK conecte minha agenda");
    const card = page.getByTestId("connect-card");
    await expect(card.getByTestId("connect-card-primary")).toHaveText("Conectar Google Agenda");
    await expect(card.getByTestId("connect-card-after")).toHaveText(
      "Depois de autorizar, me avise.",
    );
    await expect(page.getByTestId("chat")).not.toContainText("connect.composio.dev");
    await expect(page.getByTestId("chat")).not.toContainText("nao-mostrar");
    await page.screenshot({ path: `${SHOTS}/depois-5-cartao-composio.png` });
    await card.getByTestId("connect-card-primary").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __openedUrls?: string[] }).__openedUrls ?? []))
      .toEqual(["https://connect.composio.dev/link/lk_E2E?token=nao-mostrar"]);
    // A link to a host the connector does not declare never becomes a card.
    await freshBot(world, "Desconfiado");
    await page.reload();
    await selectBot(page, "Desconfiado");
    await send(page, "CASE-HANDOVER-EVIL conecte minha agenda");
    await expect(page.getByText("Tentei mostrar o link.").first()).toBeVisible();
    await expect(page.getByTestId("connect-card")).toHaveCount(0);
    await world.api.connectors.remove("composio");
  });

  test("a proposal approved in the chat: the card replaces the tool row and the bot already has the connector", async ({
    page,
  }) => {
    await freshBot(world, "Proponente");
    await openApp(page, world);
    await selectBot(page, "Proponente");
    await send(page, "CASE-PROPOSE conecte o notion");
    const approval = page.getByTestId("approval-card");
    await expect(approval).toHaveAttribute("data-state", "needs-action");
    await expect(approval).not.toContainText("https://");
    await approval.getByTestId("approval-approve").click();
    const card = page.getByTestId("connect-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("connect-card-primary")).toHaveText("Conectar");
    // No "Ferramenta · Aprovado · Instalar o conector…" row: the card is the result.
    await expect(page.getByTestId("chat")).not.toContainText("Instalar o conector");
    const bot = (await world.api.bots.list()).find((b) => b.name === "Proponente");
    expect((await world.api.connectors.get("notion")).grants).toEqual([
      { botId: bot?.id, all: true, tools: [] },
    ]);
    await world.api.connectors.remove("notion");
  });
});

export type { Page };
