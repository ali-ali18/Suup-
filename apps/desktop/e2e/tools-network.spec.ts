import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { recordNetworkEvent } from "@suup/db";
import { DATABASE_URL, fakeMcpCommand, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  botItem,
  closeSettings,
  freshBot,
  openApp,
  openSettings,
  selectBot,
  send,
} from "./helpers.js";

// Phase 3, the rest: what a bot may use of a connector TOOL by TOOL, the review of a definition the
// server changed, the network of a bot's machine, the card that asks for a host, and the measure of
// the tool definitions in the inspector. A real server, the scripted provider, the in-repo fake MCP
// server. The isolated (docker) machine is not here: the network list and its refusals are rows of
// the database the real routes read, and the card is the real tool, registered by the harness.

const botMessage = (page: Page, text: string) =>
  page.getByTestId("message-bot").filter({ hasText: text });

const botId = async (world: World, name: string): Promise<string> =>
  (await world.api.bots.list()).find((b) => b.name === name)?.id as string;

const connectorRow = (page: Page, name = "fake"): Locator =>
  page.getByTestId("connector-row").filter({ hasText: name });

/** Selects a connector in the list; its details open (and the list is gone). */
async function openConnector(page: Page, name = "fake"): Promise<Locator> {
  await page
    .getByTestId("connector-item")
    .filter({ hasText: name })
    .getByTestId("connector-details")
    .click();
  const detail = connectorRow(page, name);
  await expect(detail.getByTestId("connector-panel")).toBeVisible();
  return detail;
}

const grantRow = (row: Locator, bot: string): Locator =>
  row.locator(`[data-testid="grant-row"][data-bot="${bot}"]`);

/** Opens "Editar bot" on its second step, where the Rede section is. */
async function openBotEditor(page: Page, name: string): Promise<Locator> {
  await selectBot(page, name);
  await page.getByTestId("bot-chip").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Descrever o que ele faz" }).click();
  return dialog;
}

test.describe("per-tool grants and the review of a definition", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  let dir: string;
  test.beforeAll(async () => {
    world = await startWorld();
    dir = await mkdtemp(join(tmpdir(), "suup-e2e-review-"));
  });
  test.afterAll(async () => {
    await world?.stop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });
  test.afterEach(async () => {
    for (const c of await world.api.connectors.list()) await world.api.connectors.remove(c.name);
  });

  test("tick two tools: the bot uses one of them and cannot use one that stayed unticked", async ({
    page,
  }) => {
    await freshBot(world, "Seletivo", { allowedTools: [] });
    const { command, args } = fakeMcpCommand();
    await world.api.connectors.create({
      name: "fake",
      transport: { kind: "stdio", command, args },
      scope: "read_write",
    });
    await world.api.connectors.test("fake");
    // `echo` is a read the user vouches for: it runs without a card.
    await world.api.connectors.setToolRisk("fake", "echo", { risk: "read" });
    const offered = (await world.api.connectors.get("fake")).tools?.filter((t) => t.available);
    const total = offered?.length ?? 0;
    expect(total).toBeGreaterThan(4);

    await openApp(page, world);
    await openSettings(page, "Conectores");
    const row = await openConnector(page);
    const bot = grantRow(row, "Seletivo");
    // Nothing is ticked at first, and the collapsed row says so.
    await expect(bot).toContainText(`0 de ${total}`);
    await bot.getByRole("button", { name: /Seletivo/ }).click();
    const tick = (tool: string) => bot.locator(`[data-tool="${tool}"]`).getByRole("checkbox");
    for (const tool of ["echo", "write_thing", "lying_read"])
      await expect(tick(tool)).not.toBeChecked();
    // The risk and where it came from are shown as in the tool list.
    await expect(bot.locator('[data-tool="echo"]')).toContainText("Leitura");
    await expect(bot.locator('[data-tool="echo"]')).toContainText("Definido por você.");
    await expect(bot.locator('[data-tool="write_thing"]')).toContainText("Externa ou irreversível");
    await expect(bot.getByTestId("grant-save")).toBeDisabled();
    await tick("echo").check();
    await tick("write_thing").check();
    await expect(bot).toHaveAttribute("data-count", `2 de ${total}`);
    await bot.getByTestId("grant-save").click();
    await expect(bot.getByTestId("grant-save")).toBeDisabled();
    // The server holds exactly the two, as a list (never `all`).
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).grants)
      .toEqual([
        { botId: await botId(world, "Seletivo"), all: false, tools: ["echo", "write_thing"] },
      ]);
    // Collapsed, the row says "2 de N" and nothing else of the tools.
    await bot.getByRole("button", { name: /Seletivo/ }).click();
    await expect(bot.getByTestId("grant-card")).toContainText(`2 de ${total}`);
    await closeSettings(page);
    await openSettings(page, "Conectores");
    await expect(page.getByTestId("connector-item").filter({ hasText: "fake" })).toContainText(
      "1 bot",
    );
    await closeSettings(page);

    // The bot: the ticked tool works, the unticked one does not exist for it.
    await selectBot(page, "Seletivo");
    await send(page, "CASE-GRANTS use as ferramentas");
    await expect(botMessage(page, "Terminei: usei uma e não consegui a outra.")).toBeVisible();
    const echo = page.getByTestId("action-card").filter({ hasText: "conn_fake__echo" });
    await expect(echo).toHaveAttribute("data-state", "done");
    await echo.getByRole("button").click();
    await expect(echo.getByTestId("action-output")).toContainText("echo: oi do bot");
    const hidden = page.getByTestId("action-card").filter({ hasText: "conn_fake__lying_read" });
    await expect(hidden).toHaveAttribute("data-state", "failed");
    const runs = await world.api.runs.list({ botId: await botId(world, "Seletivo") });
    const events = await world.api.runs.events(runs.items[0]?.id as string, { limit: 500 });
    const results = events.items.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.payload.isError)).toEqual([false, true]);
    expect(String(results[1]?.payload.content)).toContain("lying_read");

    // "Nenhuma" and the shortcuts: "só as de leitura" ticks the reads, "todas" is the only `all`.
    await openSettings(page, "Conectores");
    await openConnector(page);
    const again = grantRow(connectorRow(page), "Seletivo");
    await again.getByRole("button", { name: /Seletivo/ }).click();
    await again.getByTestId("grant-read").click();
    await expect(again.locator('[data-tool="echo"]').getByRole("checkbox")).toBeChecked();
    await expect(
      again.locator('[data-tool="write_thing"]').getByRole("checkbox"),
    ).not.toBeChecked();
    await again.getByTestId("grant-save").click();
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).grants[0]?.tools)
      .toEqual(["echo"]);
    await again.getByTestId("grant-all").click();
    await again.getByTestId("grant-save").click();
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).grants[0])
      .toMatchObject({ all: true, tools: [] });
    await expect(again).toHaveAttribute(
      "data-count",
      new RegExp(`^${total} de ${total} \\(todas\\)$`),
    );
    await again.getByTestId("grant-none").click();
    await again.getByTestId("grant-save").click();
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).grants[0])
      .toMatchObject({ all: false, tools: [] });
  });

  test("a definition the server changed is off until reviewed: the notice, the comparison, the 409, the approval", async ({
    page,
  }) => {
    await freshBot(world, "Revisor A", { allowedTools: [] });
    await freshBot(world, "Revisor B", { allowedTools: [] });
    const tweak = join(dir, "tweak.txt");
    const late = join(dir, "late.txt");
    const { command, args } = fakeMcpCommand();
    await world.api.connectors.create({
      name: "fake",
      transport: { kind: "stdio", command, args, env: { FAKE_TWEAK: tweak, FAKE_LATE: late } },
      scope: "read_write",
    });
    await world.api.connectors.test("fake");
    await world.api.connectors.setToolRisk("fake", "echo", { risk: "read" });
    for (const name of ["Revisor A", "Revisor B"]) {
      await world.api.connectors.grant("fake", await botId(world, name), { tools: ["echo"] });
    }
    // The server now shows another description for `echo`, and a tool that was not there.
    await writeFile(tweak, "Now it also sends a copy of the text somewhere else.");
    await writeFile(late, "x");
    await world.api.connectors.test("fake");
    const detected = await world.api.connectors.get("fake");
    expect(detected.pendingReviews).toBe(2);

    await openApp(page, world);
    await openSettings(page, "Conectores");
    // In the list the connector only says it is waiting; the notice and "Revisar" are in its details.
    await expect(page.getByTestId("connector-item").filter({ hasText: "fake" })).toContainText(
      "espera revisão",
    );
    const row = await openConnector(page);
    const notice = row.getByTestId("review-notice");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("1 ferramenta mudou e está desligada até você revisar");
    await expect(notice).toContainText("1 ferramenta nova está desligada até você revisar");
    // The grant row shows `echo` unticked, and why.
    const bot = grantRow(row, "Revisor B");
    await bot.getByRole("button", { name: /Revisor B/ }).click();
    const echoBox = bot.locator('[data-tool="echo"]');
    await expect(echoBox.getByRole("checkbox")).toBeDisabled();
    await expect(echoBox.getByRole("checkbox")).not.toBeChecked();
    await expect(echoBox).toContainText("A definição mudou: desligada até você revisar.");
    // The tool list carries the badge too.
    await expect(
      row.locator('[data-testid="connector-tool"][data-tool="echo"]').getByTestId("tool-pin"),
    ).toContainText("definição mudou, esperando sua revisão");

    // The review: the old definition next to the new one, marked as written by the server.
    await row.getByTestId("connector-review").click();
    const dialog = page.getByRole("dialog", { name: "Revisar as ferramentas de fake" });
    const items = dialog.getByTestId("review-item");
    await expect(items).toHaveCount(2);
    const echo = items.filter({ has: page.locator('h3:has-text("echo")') });
    await expect(echo.getByTestId("review-server-text")).toContainText(
      "Texto escrito pelo servidor",
    );
    const description = echo.locator('[data-section="description"]');
    await expect(description.locator('[data-mark="removed"]')).toContainText(
      "Returns the text it was given.",
    );
    await expect(description.locator('[data-mark="added"]')).toContainText(
      "Now it also sends a copy of the text somewhere else.",
    );
    await expect(description.locator('[data-mark="added"] .diff-word').first()).toBeVisible();
    await expect(echo.locator('[data-section="schema"]').getByTestId("review-changes")).toHaveText(
      "sem mudança",
    );
    const lateTool = items.filter({ has: page.locator('h3:has-text("late_tool")') });
    await expect(lateTool.getByTestId("review-new")).toContainText("Ferramenta nova");

    // The server changes it AGAIN while the person reads: approving the old fingerprint is refused.
    await writeFile(tweak, "A third, different description.");
    await world.api.connectors.test("fake");
    await echo.getByTestId("review-approve").click();
    await expect(echo.getByTestId("review-again")).toContainText("mudou de novo");
    await expect(echo.locator('[data-section="description"]')).toContainText(
      "A third, different description.",
    );
    expect((await world.api.connectors.get("fake")).pendingReviews).toBe(2);
    await dialog.getByTestId("review-close").click();

    // Nothing was approved, so `echo` is off for every bot: the call fails as an unknown tool.
    await closeSettings(page);
    await selectBot(page, "Revisor A");
    await send(page, "CASE-GRANTS antes da revisão");
    await expect(botMessage(page, "Terminei: usei uma e não consegui a outra.")).toBeVisible();
    await expect(
      page.getByTestId("action-card").filter({ hasText: "conn_fake__echo" }),
    ).toHaveAttribute("data-state", "failed");

    // The version on screen is now the current one: approving it works.
    await openSettings(page, "Conectores");
    await openConnector(page);
    await row.getByTestId("connector-review").click();
    await expect(items).toHaveCount(2);
    await echo.getByTestId("review-approve").click();
    await expect(items).toHaveCount(1);
    expect((await world.api.connectors.get("fake")).pendingReviews).toBe(1);

    // "Manter desligada" sends nothing: the tool is still waiting.
    await dialog.getByTestId("review-keep").click();
    await expect(dialog.getByTestId("review-kept")).toContainText("Nada foi enviado ao servidor");
    expect((await world.api.connectors.get("fake")).pendingReviews).toBe(1);
    await dialog.getByTestId("review-close").click();
    await expect(notice).toContainText("1 ferramenta nova está desligada até você revisar");
    await expect(notice).not.toContainText("mudou");

    // The history says what happened.
    await row.getByTestId("tool-history").getByRole("button").click();
    const history = row.getByTestId("tool-history-list");
    await expect(history).toContainText("Você aprovou a definição: echo");
    await expect(history).toContainText("A definição mudou: echo");
    await expect(history).toContainText("Ferramenta nova: late_tool");

    // Approved, `echo` is back for the bots that have it ticked, and the bot uses it.
    await bot.getByRole("button", { name: /Revisor B/ }).click();
    await expect(bot.locator('[data-tool="echo"]').getByRole("checkbox")).toBeEnabled();
    await closeSettings(page);
    await selectBot(page, "Revisor B");
    await send(page, "CASE-GRANTS depois da revisão");
    await expect(botMessage(page, "Terminei: usei uma e não consegui a outra.")).toBeVisible();
    await expect(
      page.getByTestId("action-card").filter({ hasText: "conn_fake__echo" }),
    ).toHaveAttribute("data-state", "done");

    // The last one is approved from the notice again, and the notice goes away.
    await openSettings(page, "Conectores");
    await openConnector(page);
    await connectorRow(page).getByTestId("connector-review").click();
    await page.getByTestId("review-approve").click();
    await expect(page.getByTestId("review-empty")).toBeVisible();
    await page.getByTestId("review-close").click();
    await expect(connectorRow(page).getByTestId("review-notice")).toHaveCount(0);
    expect((await world.api.connectors.get("fake")).pendingReviews).toBe(0);
  });

  test("a stdio connector says where it runs and lets the user edit the hosts it may reach", async ({
    page,
  }) => {
    const { command, args } = fakeMcpCommand();
    await world.api.connectors.create({
      name: "fake",
      transport: { kind: "stdio", command, args },
    });
    await openApp(page, world);
    await openSettings(page, "Conectores");
    // Without Docker, the program runs on the server's own machine: no isolation, said in words.
    const row = await openConnector(page);
    await expect(row.getByTestId("connector-runs-tag")).toHaveText("no servidor, sem isolamento");
    const network = row.getByTestId("connector-network");
    await expect(network).toHaveAttribute("data-runs-in", "host");
    await expect(network.getByTestId("connector-runs-in")).toContainText("sem isolamento");
    // The hosts are the server's rule: an IP is refused with the server's own message.
    const field = network.getByLabel(/Hosts liberados só para este conector/);
    await field.fill("10.0.0.1");
    await network.getByTestId("egress-save").click();
    await expect(network.getByTestId("egress-error")).toBeVisible();
    expect((await world.api.connectors.get("fake")).transport).toMatchObject({ kind: "stdio" });
    expect(
      (await world.api.connectors.get("fake")).transport as { egressHosts?: string[] },
    ).not.toMatchObject({ egressHosts: ["10.0.0.1"] });
    await field.fill("api.exemplo.com\n  dados.exemplo.com ");
    await network.getByTestId("egress-save").click();
    await expect
      .poll(async () => (await world.api.connectors.get("fake")).transport)
      .toMatchObject({ egressHosts: ["api.exemplo.com", "dados.exemplo.com"] });
    await expect(network.getByTestId("egress-save")).toBeDisabled();
  });
});

test.describe("the network of a bot's machine", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the defaults, the bot's own hosts (add, refusal of the server, remove) and what the proxy refused", async ({
    page,
  }) => {
    await freshBot(world, "Conectado à rede");
    const id = await botId(world, "Conectado à rede");
    await recordNetworkEvent(world.db, {
      subjectKind: "bot",
      subjectId: id,
      host: "api.novo.com",
      port: 443,
      reason: "not_allowed",
      message: "host api.novo.com is not allowed for this bot",
    });
    await openApp(page, world);
    const dialog = await openBotEditor(page, "Conectado à rede");
    const section = dialog.getByTestId("bot-network");
    // This server runs the commands on its own machine: the page says there is no isolation.
    await expect(section.getByTestId("network-local-note")).toContainText("sandbox local");
    await expect(section.getByTestId("network-defaults")).toContainText("registry.npmjs.org");
    await expect(section.getByTestId("network-defaults").getByRole("button")).toHaveCount(0);
    await expect(section.getByTestId("network-hosts-empty")).toBeVisible();
    await expect(section).toContainText("O nome tem de ser exato");
    // The refusal of the proxy, with the host and when.
    const refusal = section.getByTestId("network-refusals").locator('[data-host="api.novo.com"]');
    await expect(refusal).toContainText("api.novo.com:443");
    await expect(refusal).toContainText("o host não está na lista");

    // Empty: refused here. An IP: refused by the SERVER, whose words are shown as they come.
    await section.getByTestId("network-add").click();
    await expect(section.getByRole("alert")).toHaveText("Digite o nome do host.");
    await section.getByLabel("Liberar um host").fill("10.0.0.1");
    await section.getByTestId("network-add").click();
    await expect(section.getByRole("alert")).not.toHaveText("Digite o nome do host.");
    await expect(section.getByRole("alert")).toBeVisible();
    expect((await world.api.network.forBot(id)).hosts).toEqual([]);

    // A host is added, and shows in the list the server returned.
    await section.getByLabel("Liberar um host").fill("api.exemplo.com");
    await section.getByTestId("network-add").click();
    await expect(section.getByTestId("network-hosts")).toContainText("api.exemplo.com");
    expect((await world.api.network.forBot(id)).hosts.map((h) => h.host)).toEqual([
      "api.exemplo.com",
    ]);
    // A refusal becomes "Liberar <host>" in one click.
    await section.getByRole("button", { name: "Liberar api.novo.com" }).click();
    await expect(section.getByTestId("network-hosts")).toContainText("api.novo.com");
    // Remove.
    await section.getByRole("button", { name: "Remover api.exemplo.com" }).click();
    await expect(section.getByTestId("network-hosts")).not.toContainText("api.exemplo.com");
    expect((await world.api.network.forBot(id)).hosts.map((h) => h.host)).toEqual(["api.novo.com"]);
    // The writes did not wait for "Salvar" of the bot: closing changes nothing.
    await dialog
      .getByRole("button", { name: "Cancelar" })
      .or(dialog.getByRole("button", { name: "Voltar" }))
      .first()
      .click();
    expect((await world.api.network.forBot(id)).hosts.map((h) => h.host)).toEqual(["api.novo.com"]);
  });
});

test.describe("the card that asks for a host", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ networkTool: true });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("a normal decision card: Rede, Acessar <host>, the bot's words; decided it is one collapsed row", async ({
    page,
  }) => {
    await freshBot(world, "Pedinte", { allowedTools: ["shell", "request_network_access"] });
    await openApp(page, world);
    await selectBot(page, "Pedinte");
    await send(page, "CASE-NETWORK preciso de um host");
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-state", "needs-action");
    await expect(card.locator(".ui-decision__category")).toHaveText("Rede");
    await expect(card.locator(".ui-decision__title")).toHaveText("Acessar api.novo.com");
    await expect(card.getByTestId("approval-why")).toHaveText(
      "Motivo dado pelo bot: “preciso baixar o relatório do mês”",
    );
    await expect(card.getByTestId("network-scope")).toHaveText(
      "Aprovar vale só para esta execução.",
    );
    expect(await card.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    await expect(card.locator(".ui-split")).toHaveCount(0);
    // No rows that only repeat the title and the paragraph...
    await expect(card.getByTestId("approval-content").getByTestId("arg-field")).toHaveCount(0);
    // ...and the exact content stays one click away, all of it.
    const raw = card.getByTestId("approval-raw");
    await expect(raw.getByTestId("arg-field").first()).toBeHidden(); // closed
    await raw.locator("summary").click();
    await expect(raw.locator('[data-key="host"]').getByTestId("arg-value")).toHaveText(
      "api.novo.com",
    );
    await expect(raw.locator('[data-key="reason"]').getByTestId("arg-value")).toHaveText(
      "preciso baixar o relatório do mês",
    );
    await raw.locator("summary").click();
    await card.getByTestId("approval-approve").click();
    await expect(botMessage(page, "Tentei liberar o host.")).toBeVisible();
    // One row for the call: the category, the decision, and what it was.
    const row = page.getByTestId("action-card");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".ui-action__kind")).toHaveText("Rede");
    await expect(row).toContainText("Acessar api.novo.com");
    await expect(row).toContainText("Aprovado");
    // The isolated machine has this tool: the app does not say "no isolation".
    await page.getByTestId("bot-chip").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Descrever o que ele faz" }).click();
    await expect(page.getByTestId("bot-network")).toBeVisible();
    await expect(page.getByTestId("network-defaults")).toBeVisible();
    await expect(page.getByTestId("network-local-note")).toHaveCount(0);
  });

  test("Recusar is one click and the bot goes on", async ({ page }) => {
    await freshBot(world, "Recusado", { allowedTools: ["shell", "request_network_access"] });
    await openApp(page, world);
    await selectBot(page, "Recusado");
    await send(page, "CASE-NETWORK de novo");
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-state", "needs-action");
    await card.getByTestId("approval-deny").click();
    await expect(botMessage(page, "Tentei liberar o host.")).toBeVisible();
    const row = page.getByTestId("action-card");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Recusado");
    await expect(row).toContainText("Acessar api.novo.com");
    // Nothing was allowed: the bot's own list is empty.
    expect((await world.api.network.forBot(await botId(world, "Recusado"))).hosts).toEqual([]);
    await expect(botItem(page, "Recusado")).toBeVisible();
  });
});

test.describe("tool search: the measure of the definitions, and the real tool in the chat", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ toolSearch: { minTools: 5, minDefinitionTokens: 1 } });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("search and use calls show as the real tool; the inspector says the mode and what the definitions cost", async ({
    page,
  }) => {
    await freshBot(world, "Pesquisador", { allowedTools: [] });
    const { command, args } = fakeMcpCommand();
    await world.api.connectors.create({
      name: "fake",
      transport: { kind: "stdio", command, args, env: { FAKE_MANY: "30" } },
      scope: "read_write",
    });
    await world.api.connectors.test("fake");
    await world.api.connectors.setToolRisk("fake", "gen_3", { risk: "read" });
    await world.api.connectors.grant("fake", await botId(world, "Pesquisador"), { tools: "all" });
    await openApp(page, world);
    await selectBot(page, "Pesquisador");
    await send(page, "CASE-META consulte o registro");
    await expect(botMessage(page, "Consultei o registro 7.")).toBeVisible();
    // The chat shows the lookup and the REAL tool, never the wrapper.
    const rows = page.getByTestId("action-card");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Procurar ferramentas");
    await expect(rows.nth(0)).toContainText("no conector fake");
    await expect(rows.nth(1)).toContainText("conn_fake__gen_3");
    await expect(rows.nth(1).locator(".ui-action__kind")).toHaveText("fake");
    await expect(page.getByTestId("chat")).not.toContainText("use_tool");

    // The inspector: the mode of the run, and the definitions of each request.
    await page.getByTestId("bot-chip").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Abrir o inspetor/ }).click();
    const catalog = page.getByTestId("tool-catalog");
    await expect(catalog).toHaveAttribute("data-mode", "meta");
    await expect(catalog).toContainText("pesquisa por índice");
    await expect(catalog).toContainText("ferramentas de conectores");
    const stats = page.getByTestId("tool-stats-row");
    await expect(stats.first()).toBeVisible();
    expect(await stats.count()).toBeGreaterThanOrEqual(3);
    // Every request carries the definitions, with the tokens of what is loaded and of all of them.
    const cells = await stats.first().locator("td").allTextContents();
    // The estimates are shown with a leading "~": they are estimates, not counts.
    const [definitions, deferred, estimated, loaded] = cells.map((c) => Number(c.replace("~", "")));
    expect(definitions).toBeGreaterThan(0);
    // In this mode the connector tools are not in the request at all: only the index (in the
    // prompt) and the two tools that search and call. What all of them would cost is in the mode.
    expect(deferred).toBe(0);
    expect(estimated).toBe(loaded);
    const allTokens = Number(await catalog.getAttribute("data-definition-tokens"));
    expect(allTokens).toBeGreaterThan(estimated as number);
    // The log shows the wrapper as the server wrote it: the real tool, with the real arguments.
    const runs = await world.api.runs.list({ botId: await botId(world, "Pesquisador") });
    const events = await world.api.runs.events(runs.items[0]?.id as string, { limit: 500 });
    const names = events.items.filter((e) => e.type === "tool_call").map((e) => e.payload.name);
    expect(names).toEqual(["search_tools", "conn_fake__gen_3"]);
  });
});
