import { expect, type Locator, type Page, type Response, test } from "@playwright/test";
import { DATABASE_URL, fakeMcpCommand, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  botItem,
  choose,
  expectWordsAbove,
  freshBot,
  openApp,
  openPluginPage,
  openSettings,
  openWithBot,
  selectBot,
  send,
} from "./helpers.js";

// Phase 3 in the browser, part two: the secure form of a secret request (the value must appear
// nowhere), the vault screen, and the connectors screen with a real MCP server (the in-repo fake).

const VALUE = "ghp_E2E_Super_Secret_Value_8f3a91c2";
const botMessage = (page: Page, text: string) =>
  page.getByTestId("message-bot").filter({ hasText: text });

const grantRow = (row: Locator, bot: string): Locator =>
  row.locator(`[data-testid="grant-row"][data-bot="${bot}"]`);

async function botId(world: World, name: string): Promise<string> {
  return (await world.api.bots.list()).find((b) => b.name === name)?.id as string;
}

test.describe("secret requests and the vault", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
    await freshBot(world, "Bot de teste");
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the bot asks for a credential: a secure form, the run goes on, and the value is nowhere", async ({
    page,
  }) => {
    // Everything the browser receives, except the realtime stream (which never ends).
    const bodies: string[] = [];
    page.on("response", (response: Response) => {
      if (response.url().includes("/v1/stream")) return;
      void response.text().then(
        (text) => bodies.push(`${response.url()} ${text}`),
        () => {},
      );
    });
    await openWithBot(page, world, "Cofreiro");
    await send(page, "CASE-SECRET preciso do token");
    const form = page.getByTestId("secret-card");
    await expect(form).toHaveAttribute("data-state", "needs-action");
    await expect(form).toContainText("Cofreiro pede um segredo");
    await expect(form).toContainText("para acessar a API de teste");
    const input = form.getByTestId("secret-input");
    // The NAME is the label of the field, the reassurance is in the footer, and Enviar waits for text.
    await expect(form.getByLabel("E2E_TOKEN")).toBeVisible();
    // Where the secret will be used: what the bot filled in, read-only (no field to type in).
    await expect(form.getByTestId("decision-lede")).toContainText("Vai ser usado em localhost.");
    await expect(form.getByLabel("Endereços permitidos")).toHaveCount(0);
    // No text of the system with the card; the bot's own words of that turn are the bubble above it.
    await expect(form).not.toContainText("Guardado no cofre");
    await expectWordsAbove(page, "Para usar a API de teste, preciso do seu token.", form);
    await expect(page.getByTestId("chat")).not.toContainText("eu nunca vejo o valor");
    await expect(
      page.getByTestId("bubble-bot").filter({ hasText: "preciso do seu token" }),
    ).toHaveCount(1);
    await expect(form.getByTestId("secret-save")).toBeDisabled();
    // The field: password type, no completion, no spellcheck; the focus is on it; reveal is off.
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
    const reveal = form.getByRole("button", { name: "Mostrar o valor" });
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    // The run waits for you: the bot has the doubt mark, the card is in Pendências too.
    await expect(botItem(page, "Cofreiro")).toHaveAttribute("data-chip", "doubt");
    await expect(page.getByTestId("pending-counter")).toHaveText("1");
    await input.fill(VALUE);
    await expect(form.getByTestId("secret-save")).toBeEnabled();
    await reveal.click();
    await expect(input).toHaveAttribute("type", "text");
    await form.getByRole("button", { name: "Esconder o valor" }).click();
    await expect(input).toHaveAttribute("type", "password");
    // Even typed, the value is not in the page: an input's text is not markup.
    expect(await page.content()).not.toContain(VALUE);
    await form.getByTestId("secret-save").click();
    // The chat shows only that the secret is available, and the bot goes on and uses it.
    await expect(page.getByTestId("secret-card")).toContainText("Segredo E2E_TOKEN disponível");
    await expect(page.getByTestId("secret-card")).toHaveAttribute("data-state", "done");
    // Using it asks first, and the card says where the secret would go (what the person confirmed by sending).
    const approval = page.getByTestId("approval-card");
    await expect(approval.getByTestId("approval-secret-host")).toContainText("localhost");
    await approval.getByTestId("approval-approve").click();
    await expect(botMessage(page, "Recebi o segredo e usei.")).toBeVisible();
    // The command is no row in the chat (steps live in the Inspector); what it printed is in the run's log.
    await expect(page.getByTestId("action-card")).toHaveCount(0);
    // The value appears nowhere: the DOM, the browser's storage, anything the server answered.
    expect(await page.content()).not.toContain(VALUE);
    const storage = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(storage).not.toContain(VALUE);
    await page.waitForTimeout(300);
    expect(bodies.join("\n")).not.toContain(VALUE);
    expect(bodies.join("\n")).toContain("E2E_TOKEN");
    // Nor in the API: the log of the run, the messages, the list of secrets.
    const bot = await botId(world, "Cofreiro");
    const runs = await world.api.runs.list({ botId: bot });
    const events = await world.api.runs.events(runs.items[0]?.id as string, { limit: 500 });
    expect(JSON.stringify(events)).not.toContain(VALUE);
    expect(JSON.stringify(events)).toContain("token-recebido=[REDACTED:E2E_TOKEN]");
    const conversation = await world.api.bots.openConversation(bot);
    expect(
      JSON.stringify(await world.api.conversations.messages(conversation.id, { limit: 100 })),
    ).not.toContain(VALUE);
    const secrets = await world.api.vault.list();
    expect(JSON.stringify(secrets)).not.toContain(VALUE);
    expect(secrets.find((s) => s.name === "E2E_TOKEN")?.grantedBotIds).toEqual([bot]);
    // What was kept is what the person confirmed, not what the bot suggested.
    expect(secrets.find((s) => s.name === "E2E_TOKEN")?.hosts).toEqual(["localhost"]);
    // After a reload the card is one line, and still says only that.
    await page.reload();
    await botItem(page, "Cofreiro").click();
    await expect(page.getByTestId("secret-card")).toContainText("Segredo E2E_TOKEN disponível");
    await expect(page.getByTestId("secret-input")).toHaveCount(0);
    expect(await page.content()).not.toContain(VALUE);
  });

  test("the request also shows in Pendências, where it can be declined: the bot goes on without it", async ({
    page,
  }) => {
    await openWithBot(page, world, "Recusador");
    await send(page, "CASE-SECRET-NO preciso de outro token");
    await expect(page.getByTestId("secret-card")).toHaveAttribute("data-state", "needs-action");
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: /Pendências/ }).click();
    const item = page.getByTestId("pending-secret");
    await expect(item).toHaveCount(1);
    // It is a secret request, not a question: it is not listed with the questions.
    await expect(page.getByTestId("pending-question")).toHaveCount(0);
    await item.getByTestId("secret-decline").click();
    await expect(page.getByTestId("pending-secret")).toHaveCount(0);
    await botItem(page, "Recusador").click();
    await expect(page.getByTestId("secret-card")).toContainText(
      "Você recusou o segredo E2E_RECUSADO",
    );
    await expect(botMessage(page, "Sem o segredo, sigo de outro jeito.")).toBeVisible();
    expect((await world.api.vault.list()).some((s) => s.name === "E2E_RECUSADO")).toBe(false);
  });

  test("the vault screen: create, grant per bot, replace and delete; names and metadata only, never a value", async ({
    page,
  }) => {
    await freshBot(world, "Usuário do cofre");
    await openApp(page, world);
    await openSettings(page, "Cofre");
    // the name of the key's variable is technical: nowhere on the screen
    await expect(page.getByTestId("settings-screen")).not.toContainText("SUUP_E2E_VAULT_KEY");
    await expect(page.getByTestId("vault-status")).toContainText("nunca é mostrado");
    // Create.
    await page.getByTestId("secret-new").click();
    const dialog = page.getByRole("dialog", { name: "Novo segredo" });
    await dialog.getByLabel("Nome").fill("tela_token");
    await expect(dialog.getByLabel("Nome")).toHaveValue("TELA_TOKEN");
    await dialog.getByLabel("Para que serve (opcional)").fill("token da tela de teste");
    const input = dialog.getByTestId("secret-input");
    await expect(input).toHaveAttribute("type", "password");
    // A secret of the owner says where it may go: without a site it is not saved (the value stays).
    await input.fill(VALUE);
    await dialog.getByTestId("secret-write").click();
    await expect(dialog.getByRole("alert")).toContainText("Diga para onde o segredo pode ir");
    await expect(input).toHaveValue(VALUE);
    await dialog.getByLabel("Endereços permitidos").fill("https://api.exemplo.com");
    await dialog.getByTestId("secret-write").click();
    await expect(dialog.getByRole("alert")).toContainText("não é um endereço válido");
    await dialog.getByLabel("Endereços permitidos").fill("API.exemplo.com\noutra.exemplo.com");
    // Too short: explained, never echoed.
    await input.fill("curto");
    await dialog.getByTestId("secret-write").click();
    await expect(dialog.getByRole("alert")).toContainText("pelo menos 8 caracteres");
    await expect(dialog.getByRole("alert")).not.toContainText("curto");
    await input.fill(VALUE);
    await dialog.getByTestId("secret-write").click();
    const row = page.getByTestId("secret-row").filter({ hasText: "TELA_TOKEN" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pode ir para api.exemplo.com, outra.exemplo.com");
    await expect(page.getByTestId("vault-blocked-notice")).toHaveCount(0);
    await expect(row).toContainText("token da tela de teste");
    await expect(row).toContainText("Nunca usado");
    await expect(row).toContainText("nenhum bot pode usar");
    expect(await page.content()).not.toContain(VALUE);
    // The search is an exact substring over the names already loaded.
    await page.getByLabel("Pesquisar no cofre").fill("nada-assim");
    await expect(row).toHaveCount(0);
    await page.getByLabel("Pesquisar no cofre").fill("tela_t");
    await expect(row).toBeVisible();
    await page.getByLabel("Pesquisar no cofre").fill("");
    // Grants are toggles, per bot, and they come from the server.
    await row.getByTestId("secret-grants-toggle").click();
    const toggle = row.getByRole("switch", { name: "Usuário do cofre pode usar TELA_TOKEN" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      (await world.api.vault.list()).find((s) => s.name === "TELA_TOKEN")?.grantedBotIds,
    ).toEqual([await botId(world, "Usuário do cofre")]);
    await expect(row).toContainText("1 bot pode usar");
    // Replace the value: the grants stay.
    await row.getByTestId("secret-replace").click();
    const replace = page.getByRole("dialog", { name: "Trocar o valor de TELA_TOKEN" });
    // The sites it may go to start as they were.
    await expect(replace.getByLabel("Endereços permitidos")).toHaveValue(
      "api.exemplo.com\noutra.exemplo.com",
    );
    await replace.getByTestId("secret-input").fill(`${VALUE}-novo`);
    await replace.getByTestId("secret-write").click();
    await expect(replace).toHaveCount(0);
    await expect(row).toContainText("1 bot pode usar");
    // Changing only the sites, from the open row: the value is not asked for.
    await row.getByLabel("Endereços permitidos").fill("so-esta.exemplo.com");
    await row.getByTestId("secret-hosts-save").click();
    await expect(row).toContainText("Pode ir para so-esta.exemplo.com");
    expect((await world.api.vault.list()).find((s) => s.name === "TELA_TOKEN")?.hosts).toEqual([
      "so-esta.exemplo.com",
    ]);
    // Nothing on the screen or in the API has any value.
    expect(await page.content()).not.toContain(VALUE);
    expect(JSON.stringify(await world.api.vault.list())).not.toContain(VALUE);
    // Delete asks first, and says what stops working.
    await row.getByTestId("secret-delete").click();
    const confirm = page.getByRole("dialog", { name: "Apagar TELA_TOKEN?" });
    await expect(confirm).toContainText("deixa de funcionar");
    await confirm.getByRole("button", { name: "Cancelar" }).click();
    await expect(row).toBeVisible();
    await row.getByTestId("secret-delete").click();
    await page.getByTestId("secret-delete-confirm").click();
    await expect(page.getByTestId("secret-row").filter({ hasText: "TELA_TOKEN" })).toHaveCount(0);
    expect((await world.api.vault.list()).some((s) => s.name === "TELA_TOKEN")).toBe(false);
  });

  test("an old secret with no sites is blocked: the screen says so and lets the person declare where it may go", async ({
    page,
  }) => {
    // Written before the sites existed: no hosts, so no bot can use it anywhere.
    await world.api.vault.set("VELHO_TOKEN", { value: `${VALUE}-velho` });
    await openApp(page, world);
    await openSettings(page, "Cofre");
    const row = page.getByTestId("secret-row").filter({ hasText: "VELHO_TOKEN" });
    await expect(row).toContainText("Bloqueado até você dizer para onde ele pode ir");
    await expect(page.getByTestId("vault-blocked-notice")).toContainText("bloqueado");
    // The action says what to do, in plain words, and opens the place to do it.
    await row.getByRole("button", { name: "Dizer para onde pode ir" }).click();
    const hosts = row.getByLabel("Endereços permitidos");
    await hosts.fill("*.exemplo.com");
    await row.getByTestId("secret-hosts-save").click();
    await expect(row).toContainText("não é um endereço válido");
    await hosts.fill("api.velho.exemplo.com");
    await row.getByTestId("secret-hosts-save").click();
    await expect(row).toContainText("Pode ir para api.velho.exemplo.com");
    await expect(row).not.toContainText("Bloqueado");
    await expect(page.getByTestId("vault-blocked-notice")).toHaveCount(0);
    expect((await world.api.vault.list()).find((s) => s.name === "VELHO_TOKEN")).toMatchObject({
      hosts: ["api.velho.exemplo.com"],
      blocked: false,
    });
    await world.api.vault.remove("VELHO_TOKEN");
  });
});

test.describe("a server without a vault", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ vault: false });
    await freshBot(world, "Bot de teste");
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the vault screen says so, and does not offer to write", async ({ page }) => {
    await openApp(page, world);
    await openSettings(page, "Cofre");
    const notice = page.getByTestId("vault-missing");
    await expect(notice).toContainText("Este servidor não tem cofre configurado");
    await expect(notice).toContainText("quem cuida do servidor precisa ligá-lo");
    await expect(notice).not.toContainText("suup vault key generate");
    await expect(page.getByTestId("secret-new")).toBeDisabled();
    await expect(page.getByTestId("vault-empty")).toContainText("Nada guardado ainda");
  });
});

test.describe("connectors", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
    await freshBot(world, "Bot de teste");
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("add a connector, grant it to a bot, read its tools and risks, and a connector write tool asks for approval", async ({
    page,
  }) => {
    await openWithBot(page, world, "Conectado");
    await openSettings(page, "Conectores");
    await expect(page.getByTestId("connectors-card")).toContainText("Nenhum plugin instalado");
    // The form says, in plain words, what a local program is.
    await page.getByTestId("connector-new").click();
    const dialog = page.getByRole("dialog", { name: "Adicionar conector" });
    await expect(dialog.getByTestId("connector-warning")).toContainText(
      "fora da máquina isolada dos bots",
    );
    await expect(dialog.getByTestId("connector-warning")).toContainText(
      "Só instale servidores em que você confia",
    );
    // A command with spaces is refused with the way out, before anything is sent.
    const { command, args } = fakeMcpCommand();
    await dialog.getByLabel("Nome", { exact: true }).fill("fake");
    await dialog.getByLabel("Programa").fill(`${command} ${args[0]}`);
    await dialog.getByTestId("connector-create").click();
    await expect(dialog).toContainText("Só o programa, sem espaços");
    await dialog.getByLabel("Programa").fill(command);
    await dialog.getByLabel("Argumentos (um por linha)").fill(args.join("\n"));
    await choose(
      page,
      dialog.getByLabel("Escopo"),
      "Leitura e escrita (as que escrevem pedem cartão)",
    );
    // Nothing is granted at creation: the tools are chosen per bot afterwards.
    await expect(dialog.getByTestId("connector-grant-hint")).toContainText("Nenhum bot recebe");
    await expect(dialog.getByRole("checkbox", { name: "Conectado" })).toHaveCount(0);
    await dialog.getByTestId("connector-create").click();
    // The installed list: one calm row, its own name, a line in plain words and where it stands.
    const item = page.getByTestId("installed-item").filter({ hasText: "fake" });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Ferramentas ainda não listadas");
    await expect(item).toContainText("nenhum bot");
    await expect(item.getByTestId("installed-state")).toHaveText("Conectado");
    await expect(page.getByTestId("connector-panel")).toHaveCount(0);
    // Nothing is managed in the list: a click opens the plugin's own page, and Settings closes.
    await item.locator("button").first().click();
    await expect(page.getByTestId("settings-screen")).toHaveCount(0);
    await expect(page.getByTestId("connector-page")).toHaveAttribute("data-kind", "manual");
    const row = page.getByTestId("connector-row").filter({ hasText: "fake" });
    // Two states said plainly, each with its action.
    await expect(row.getByTestId("plugin-no-bots")).toContainText(
      "Nenhum bot usa este plugin ainda",
    );
    await expect(row.getByTestId("plugin-unlisted")).toContainText(
      "Ainda não consegui ver as ferramentas",
    );
    await expect(row.getByTestId("connector-panel")).toBeVisible();
    await expect(row.getByTestId("connector-health")).toHaveText("Teste para ver as ferramentas.");
    // Test: it really starts the server, lists its tools and shows the result.
    await row.getByTestId("connector-test").click();
    const result = row.getByTestId("connector-test-result");
    await expect(result).toHaveAttribute("data-ok", "true");
    await expect(result).toContainText("Funcionou:");
    // the server's name and version are technical: not on the screen
    await expect(result).not.toContainText("fake-server 1.2.3");
    await expect(row.getByTestId("connector-health")).toContainText("ferramentas oferecidas");
    // The panel: the grants (a row per bot with a count), scope, the tools with the risk and origin.
    const panel = row.getByTestId("connector-panel");
    const access = grantRow(row, "Conectado");
    await expect(access).toContainText("0 de");
    await access.getByRole("button", { name: /Conectado/ }).click();
    await access.getByTestId("grant-all").click();
    await access.getByTestId("grant-save").click();
    await expect(access.getByTestId("grant-card")).toContainText("(todas)");
    await access.getByRole("button", { name: /Conectado/ }).click();
    await expect(panel.getByRole("switch", { name: "fake: somente leitura" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const echo = panel.locator('[data-testid="connector-tool"][data-tool="echo"]');
    // A tool is one row; its details open on its own button.
    await expect(echo.getByTestId("tool-basis")).toHaveCount(0);
    await echo.getByTestId("connector-tool-toggle").click();
    // the internal registered name stays out of sight
    await expect(echo).not.toContainText("conn_fake__echo");
    await expect(echo).toContainText("Externa ou irreversível");
    await expect(echo.getByTestId("tool-basis")).toContainText("Padrão: pergunta antes de rodar.");
    await expect(echo.getByTestId("tool-basis")).toContainText("só lê");
    // What the server says about a tool is quoted, and marked as written by the server.
    await expect(echo.getByTestId("tool-description")).toContainText("escrito pelo servidor");
    await expect(echo.getByTestId("tool-description")).toContainText(
      "Returns the text it was given.",
    );
    // Marking a tool as a read: the risk and its origin change, and "read" says what it means.
    await expect(panel).toContainText("roda sem cartão de aprovação");
    await choose(page, echo.getByTestId("tool-risk"), "Leitura");
    await expect(echo.getByTestId("tool-basis")).toContainText("Definido por você.");
    await expect(echo.locator('span[data-testid="tag"]', { hasText: /^Leitura$/ })).toBeVisible();
    expect((await world.api.connectors.get("fake")).toolOverrides.echo?.risk).toBe("read");
    // The server says this one is destructive: it cannot be loosened, and the way out is explained.
    const contradicted = panel.locator('[data-testid="connector-tool"][data-tool="contradicted"]');
    await contradicted.getByTestId("connector-tool-toggle").click();
    await choose(page, contradicted.getByTestId("tool-risk"), "Leitura");
    await expect(contradicted.getByTestId("tool-basis")).toContainText("Apertado pelo servidor");
    await expect(contradicted).toContainText("crie uma regra em Configurações > Permissões");
    await expect(contradicted).toContainText("Externa ou irreversível");
    // Tools that are not offered have their own section, with the reason.
    const unavailable = panel.getByTestId("connector-tools-unavailable");
    await expect(unavailable).toContainText("bad_all_of");
    await unavailable
      .locator('[data-tool="bad_all_of"]')
      .getByTestId("connector-tool-toggle")
      .click();
    await expect(
      unavailable.locator('[data-tool="bad_all_of"]').getByTestId("tool-unavailable-reason"),
    ).toContainText("Não é oferecida aos bots");
    // Read-only scope: the write tool is no longer offered, and says why; back again.
    const scope = panel.getByRole("switch", { name: "fake: somente leitura" });
    await scope.click();
    await expect(scope).toHaveAttribute("aria-checked", "true");
    await expect(unavailable.locator('[data-tool="write_thing"]')).toBeVisible();
    await scope.click();
    await expect(scope).toHaveAttribute("aria-checked", "false");
    await expect(
      panel.getByTestId("connector-tools").locator('[data-tool="write_thing"]'),
    ).toBeVisible();
    // Turning it off is immediate; turning it on warns about what a local program is.
    const enabled = row.getByRole("switch", { name: "fake: ligado" });
    await enabled.click();
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await enabled.click();
    const warn = page.getByRole("dialog", { name: "Ligar o conector fake?" });
    await expect(warn.getByTestId("connector-enable-warning")).toContainText(
      "com as permissões do usuário que roda o Suup",
    );
    await warn.getByTestId("connector-enable-confirm").click();
    await expect(enabled).toHaveAttribute("aria-checked", "true");

    // Now the bot: its write tool asks for approval, showing the connector and the tool apart.
    await selectBot(page, "Conectado");
    await send(page, "CASE-CONNECTOR crie uma coisa");
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-state", "needs-action");
    await expect(card.getByTestId("approval-connector")).toContainText("fake");
    await expect(card).toContainText("write_thing");
    await expect(card.locator('[data-testid="decision-category"]')).toHaveText("fake");
    await expect(card).toContainText("sai deste computador para um servidor externo");
    // (The server keeps the arguments in a JSON column, which does not keep the order of the keys.)
    await expect(card.locator('[data-key="name"]').getByTestId("arg-value")).toHaveText("coisa");
    await expect(card.locator('[data-key="body"]').getByTestId("arg-value")).toHaveText(
      "corpo enviado pelo conector",
    );
    await card.getByTestId("approval-approve").click();
    await expect(botMessage(page, "Criei a coisa no conector.")).toBeVisible();
    // The call is no row; the decision stays as one line, with the connector's name as its category.
    await expect(page.getByTestId("action-card")).toHaveCount(0);
    const decided = page.getByTestId("approval-card");
    await expect(decided).toHaveCount(1);
    await expect(decided).toHaveAttribute("data-state", "done");
    await expect(decided.locator('[data-testid="action-kind"]')).toHaveText("fake");
    await expect(decided).toContainText("Aprovado");
    await expect(decided).not.toContainText("conn_fake__write_thing");
    // Removing it asks first; the bot loses the tools.
    await openPluginPage(page, "fake");
    await page
      .getByTestId("connector-row")
      .filter({ hasText: "fake" })
      .getByTestId("connector-delete")
      .click();
    await page.getByTestId("connector-delete-confirm").click();
    await expect(page.getByTestId("connector-row")).toHaveCount(0);
    await openSettings(page, "Conectores");
    await expect(page.getByTestId("installed-item")).toHaveCount(0);
    expect(await world.api.connectors.list()).toHaveLength(0);
  });

  test("only a tool the user marks as a message gets the split button; its menu is about the recipient", async ({
    page,
  }) => {
    await freshBot(world, "Postal", { allowedTools: [] });
    await freshBot(world, "Postal 2", { allowedTools: [] });
    const { command, args } = fakeMcpCommand();
    await world.api.connectors.create({
      name: "fake",
      transport: { kind: "stdio", command, args },
      scope: "read_write",
      grants: [
        { botId: await botId(world, "Postal"), tools: "all" },
        { botId: await botId(world, "Postal 2"), tools: "all" },
      ],
    });
    await openApp(page, world);

    // 1. Not marked: a send_email tool is a normal write, whatever its name says. Only Recusar and Aprovar.
    await selectBot(page, "Postal 2");
    await send(page, "CASE-EMAIL-NORMAL mande o plano");
    const plain = page.getByTestId("approval-card");
    await expect(plain).toHaveAttribute("data-state", "needs-action");
    await expect(plain.locator('[data-testid="decision-category"]')).toHaveText("fake");
    expect(await plain.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    await expect(plain.locator('[data-testid="split-button"]')).toHaveCount(0);
    await expect(plain.getByTestId("approval-more")).toHaveCount(0);
    await plain.getByTestId("approval-approve").click();
    await expect(botMessage(page, "E-mail normal enviado.")).toBeVisible();

    // 2. The user marks the tool in the connector's settings and names the recipient field.
    await openPluginPage(page, "fake");
    const row = page.getByTestId("connector-row").filter({ hasText: "fake" });
    const tool = row
      .getByTestId("connector-panel")
      .locator('[data-testid="connector-tool"][data-tool="send_email"]');
    await tool.getByTestId("connector-tool-toggle").click();
    await expect(tool.getByTestId("tool-outbound-check")).toHaveAttribute("aria-checked", "false");
    await tool.getByTestId("tool-outbound-check").click();
    await tool.getByTestId("tool-outbound-fields").fill("to");
    await tool.getByTestId("tool-outbound-save").click();
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).toolOverrides.send_email)
      .toEqual({ outbound: { kind: "message", recipientFields: ["to"] } });
    // The server's other tools are untouched.
    expect((await world.api.connectors.get("fake")).toolOverrides.write_thing).toBeUndefined();

    // 3. Now its card is the message card: Descartar and the split button Enviar.
    await selectBot(page, "Postal");
    await send(page, "CASE-EMAIL-MARCADO mande o e-mail");
    const message = page.getByTestId("approval-card");
    await expect(message).toHaveAttribute("data-state", "needs-action");
    await expect(message.locator('[data-testid="decision-category"]')).toHaveText("Mensagem");
    await expect(message.getByTestId("approval-deny")).toHaveText("Descartar");
    await expect(message.getByTestId("approval-approve")).toHaveText("Enviar");
    await message.getByTestId("approval-more").click();
    const items = page.getByRole("menu").locator('[role^="menuitem"]');
    await expect(items).toHaveText([
      /Permitir destinatário/,
      /Precisa de aprovação/,
      /Gerenciar regras/,
    ]);
    await expect(page.getByTestId("approval-needs")).toHaveAttribute("aria-checked", "true");
    // Opened by the pointer the menu holds the focus; the first arrow goes to the first item.
    await expect(page.getByRole("menu")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // "Gerenciar regras" opens Configurações > Permissões.
    await message.getByTestId("approval-more").click();
    await page.getByTestId("approval-manage-rules").click();
    await expect(page.getByRole("tab", { name: "Permissões" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await selectBot(page, "Postal");
    // "Permitir destinatário": sends and writes a rule for exactly this recipient, for this bot.
    await message.getByTestId("approval-more").click();
    await page.getByTestId("allow-recipient").click();
    await expect(botMessage(page, "E-mail enviado.")).toBeVisible();
    const rules = (await world.api.rules.list()).filter((r) => r.tool === "conn_fake__send_email");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      botId: await botId(world, "Postal"),
      createdBy: "approval",
      matchers: [{ field: "to", value: "ana@exemplo.com" }],
    });
    await openSettings(page, "Permissões");
    // An exact rule is not in the main view: the quiet row at the end opens the old list.
    await page.getByTestId("rules-exact-open").click();
    await expect(page.getByTestId("rule-sentence")).toContainText(
      "o campo to é exatamente “ana@exemplo.com”",
    );
    await page.getByTestId("rules-exact-close").click();
    await world.api.rules.remove(rules[0]?.id as string);
    await world.api.connectors.remove("fake");
  });

  test("a connector that cannot start says why, with its name, on the card and on the test", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Conectores");
    await page.getByTestId("connector-new").click();
    const dialog = page.getByRole("dialog", { name: "Adicionar conector" });
    await dialog.getByLabel("Nome", { exact: true }).fill("quebrado");
    await dialog.getByLabel("Programa").fill("/caminho/que/nao/existe");
    await dialog.getByTestId("connector-create").click();
    await page
      .getByTestId("installed-item")
      .filter({ hasText: "quebrado" })
      .locator("button")
      .first()
      .click();
    const row = page.getByTestId("connector-row").filter({ hasText: "quebrado" });
    await expect(row).toBeVisible();
    await row.getByTestId("connector-test").click();
    const result = row.getByTestId("connector-test-result");
    await expect(result).toHaveAttribute("data-ok", "false");
    // a friendly sentence; the raw error (the path, the system's words) stays in the logs
    await expect(result).toHaveText("Não deu para falar com o conector agora. Tenta de novo?");
    await expect(row).not.toContainText("/caminho/que/nao/existe");
    await expect(row.getByTestId("connector-health")).toHaveText("Não está respondendo agora.");
    await row.getByTestId("connector-delete").click();
    await page.getByTestId("connector-delete-confirm").click();
    await expect(page.getByTestId("connector-row")).toHaveCount(0);
  });

  test("an HTTP connector takes its token from the vault, never typed in the form", async ({
    page,
  }) => {
    await openApp(page, world);
    await world.api.vault.set("HTTP_TOKEN", { value: "um-token-http-123" });
    await openSettings(page, "Conectores");
    await page.getByTestId("connector-new").click();
    const dialog = page.getByRole("dialog", { name: "Adicionar conector" });
    await dialog.getByTestId("connector-kind-http").click();
    await expect(dialog.getByTestId("connector-warning")).toContainText(
      "recebe tudo o que o bot enviar",
    );
    await dialog.getByLabel("Nome", { exact: true }).fill("remoto");
    await dialog.getByLabel("Endereço (URL)").fill("http://localhost:9/mcp");
    await dialog.getByRole("button", { name: "Authorization: Bearer (segredo)" }).click();
    await expect(dialog.getByLabel("Segredo")).toContainText("HTTP_TOKEN");
    await dialog.getByTestId("connector-create").click();
    const row = page.getByTestId("installed-item").filter({ hasText: "remoto" });
    await expect(row).toContainText("Ferramentas ainda não listadas");
    const saved = await world.api.connectors.get("remoto");
    expect(saved.transport).toMatchObject({
      kind: "http",
      headers: { Authorization: { secret: "HTTP_TOKEN", prefix: "Bearer " } },
    });
    expect(JSON.stringify(saved)).not.toContain("um-token-http-123");
    await world.api.connectors.remove("remoto");
    await world.api.vault.remove("HTTP_TOKEN");
  });

  test("a plugin's page is not in Settings: Esc closes the dialog, and the page has its own way back; separators run edge to edge and rows carry an icon", async ({
    page,
  }) => {
    await world.api.connectors.create({
      name: "navega",
      description: "Para andar entre a lista e os detalhes",
      transport: { kind: "stdio", ...fakeMcpCommand() },
      scope: "read_write",
    });
    await openApp(page, world);
    await openSettings(page, "Conectores");
    const item = page.getByTestId("installed-item").filter({ hasText: "navega" });
    await expect(item).toBeVisible();
    // The row has the generic plug in the one icon slot (a connector added by hand).
    await expect(item.locator("svg.lucide-plug")).toHaveCount(1);
    const dialog = page.getByTestId("settings-screen");
    await expect(dialog.getByRole("button", { name: "Conectores", exact: true })).toHaveCount(0);
    await item.locator("button").first().click();
    await expect(dialog).toHaveCount(0);
    const pluginPage = page.getByTestId("connector-page");
    await expect(pluginPage.locator("h1")).toHaveText("navega");
    await expect(page.getByTestId("connector-panel")).toBeVisible();
    // The page's groups have their icons (Quem pode usar, Ajustes, Histórico...).
    for (const label of ["Quem pode usar", "Ajustes", "Histórico"]) {
      await expect(
        pluginPage.locator("h3", { hasText: new RegExp(`^${label}$`) }).locator("svg"),
      ).toHaveCount(1);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: "screenshots/1440x900@2x/22j-config-conector-sem-botao-voltar.png",
    });
    // Separators: the line between rows starts at the card's left edge and ends at its right edge.
    const card = page
      .getByTestId("connector-panel")
      .locator("section", { has: page.locator("h3", { hasText: /^Ajustes$/ }) })
      .locator(":scope > div");
    const second = card.locator(":scope > * + *").first();
    const edges = await second.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const line = getComputedStyle(el, "::before");
      const parent = (el.parentElement as HTMLElement).getBoundingClientRect();
      return {
        left: rect.left + Number.parseFloat(line.left),
        right: rect.right - Number.parseFloat(line.right),
        cardLeft: parent.left,
        cardRight: parent.right,
      };
    });
    expect(Math.abs(edges.left - edges.cardLeft)).toBeLessThanOrEqual(2);
    expect(Math.abs(edges.right - edges.cardRight)).toBeLessThanOrEqual(2);
    // The way back is the path ("Conectores"), and Esc, to the gallery.
    await page.getByTestId("connector-back").click();
    await expect(page.getByTestId("connectors-screen")).toBeVisible();
    await world.api.connectors.remove("navega");
  });
});
