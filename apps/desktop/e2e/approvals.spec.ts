import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, freshBot, openWithBot, selectBot, send } from "./helpers.js";

// Phase 3 in the browser: the approval card (approve, deny (one click), always allow through the menu, decided
// elsewhere, cancelled), the permanent rules, and the secure form of a secret request. Everything
// runs against the real server with the scripted provider: nothing is mocked.

// The decision card (waiting for you) and the row of a call (what the bot did, an approval merged in).
const card = (page: Page) => page.getByTestId("approval-card");
const row = (page: Page) => page.getByTestId("action-card");
const botMessage = (page: Page, text: string) =>
  page.getByTestId("message-bot").filter({ hasText: text });

async function openSettings(page: Page, tab: "Geral" | "Aprovações" | "Cofre" | "Conectores") {
  await page.getByTestId("owner-menu").click();
  await page.getByRole("menuitem", { name: "Configurações" }).click();
  await page.getByRole("tab", { name: tab }).click();
}

async function botId(world: World, name: string): Promise<string> {
  const bots = await world.api.bots.list();
  return bots.find((b) => b.name === name)?.id as string;
}

test.describe("approval cards", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("approve: the card shows exactly what will run, waits for the server, then collapses to one line and the run goes on", async ({
    page,
  }) => {
    await openWithBot(page, world, "Aprovador");
    await send(page, "CASE-APPROVE escreva o arquivo");
    const pending = card(page);
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    // The preview: every argument, as sent, and the risk of the call.
    const fields = pending.getByTestId("arg-field");
    await expect(fields).toHaveCount(2);
    await expect(fields.nth(0)).toHaveAttribute("data-key", "path");
    await expect(fields.nth(0).getByTestId("arg-value")).toHaveText("aprovado.txt");
    await expect(fields.nth(1).getByTestId("arg-value")).toHaveText(
      /conteúdo aprovado\s+segunda linha/,
    );
    await expect(pending).toContainText("Externa ou irreversível");
    await expect(pending).toContainText("Aprovador quer escrever um arquivo");
    // The title is ours, in pt-BR; the category is in the header; the risk is quiet text.
    await expect(pending).toContainText("Escrever aprovado.txt");
    await expect(pending.locator(".ui-decision__category")).toHaveText("Arquivo");
    await expect(pending.getByTestId("approval-risk")).toHaveText(/Externa ou irreversível/);
    // Border, radius and reading width of the shared chrome.
    await expect(pending).toHaveCSS("border-top-width", "1px");
    await expect(pending).toHaveCSS("border-top-left-radius", "24px");
    expect((await pending.boundingBox())?.width ?? 0).toBeLessThanOrEqual(700);
    // The buttons are underneath the content.
    const contentBox = await pending.getByTestId("approval-content").boundingBox();
    const buttonBox = await pending.getByTestId("approval-approve").boundingBox();
    expect(buttonBox?.y ?? 0).toBeGreaterThan((contentBox?.y ?? 0) + (contentBox?.height ?? 0) - 1);
    // What waits for you shows everywhere: the bot's badge, the counter, the avatar's state, the live region.
    await expect(botItem(page, "Aprovador")).toHaveAttribute("data-chip", "permission");
    await expect(botItem(page, "Aprovador").getByTestId("bot-badge")).toHaveText("1");
    await expect(botItem(page, "Aprovador").getByTestId("bot-badge")).toHaveAttribute(
      "data-kind",
      "question",
    );
    await expect(page.getByTestId("pending-counter")).toHaveText("1");
    await expect(botItem(page, "Aprovador").locator("[data-mascot]")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await expect(page.getByTestId("approval-announcer")).toContainText("Aprovador pede aprovação");
    // The card took the focus when it appeared (the card, not a button: a stray Enter decides nothing).
    await expect(pending).toBeFocused();

    // Not optimistic: with the server slow to answer, the card is still the same card, waiting.
    await page.route("**/v1/approvals/*/decision", async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await pending.getByTestId("approval-approve").click();
    await expect(pending.getByTestId("approval-approve")).toContainText("Aprovando…");
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    for (const button of await pending.getByRole("button").all())
      await expect(button).toBeDisabled();
    await expect(pending.getByTestId("approval-more")).toBeDisabled();
    // Confirmed: ONE line for the call, with the decision and the execution together, closed; the run
    // goes on and the bot says so. The decision card is gone and no second row stands for the tool.
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
    await expect(row(page)).toContainText("Arquivo");
    await expect(row(page)).toContainText("Aprovado e concluído · Escrever aprovado.txt");
    await expect(row(page).getByRole("button", { name: /Aprovado/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.unroute("**/v1/approvals/*/decision");
    // The row's chevron shows only on hover and on keyboard focus, and the row expands to what was
    // approved and what ran, and collapses again.
    await page.mouse.move(0, 0);
    const resolved = row(page);
    const rowButton = resolved.getByRole("button").first();
    const chevron = resolved.locator(".ui-action__chevron");
    await expect(chevron).toHaveCSS("opacity", "0");
    await rowButton.hover();
    await expect(chevron).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(chevron).toHaveCSS("opacity", "0");
    await page.keyboard.press("Tab");
    for (
      let i = 0;
      i < 40 && !(await rowButton.evaluate((el) => el === document.activeElement));
      i++
    )
      await page.keyboard.press("Tab");
    await expect(rowButton).toBeFocused();
    await expect(chevron).toHaveCSS("opacity", "1");
    await rowButton.blur();
    await rowButton.click();
    await expect(row(page).getByRole("region")).toContainText("Você aprovou");
    // What was approved, exactly, and what the tool answered.
    await expect(row(page).getByTestId("arg-value").first()).toHaveText("aprovado.txt");
    await expect(row(page).getByTestId("arg-value").nth(1)).toHaveText(
      /conteúdo aprovado\s+segunda linha/,
    );
    await expect(row(page).getByTestId("action-output")).toBeVisible();
    await expect(row(page).getByRole("button")).toHaveCount(1);
    await rowButton.click();
    await expect(row(page).getByRole("region")).toHaveCount(0);
    // Nothing waits any more: the badge, the counter and the avatar went back.
    await expect(botItem(page, "Aprovador").getByTestId("bot-badge")).toHaveCount(0);
    await expect(page.getByTestId("pending-counter")).toHaveCount(0);
    // After a reload the card is still there, decided (it comes from the server, not from memory).
    await page.reload();
    await botItem(page, "Aprovador").click();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
    await expect(row(page)).toContainText("Aprovado e concluído · Escrever aprovado.txt");
  });

  test("deny is one click, with no reason field: the bot is told, goes on and says so", async ({
    page,
  }) => {
    await openWithBot(page, world, "Negador");
    await send(page, "CASE-DENY escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await expect(card(page).getByRole("textbox")).toHaveCount(0);
    await card(page).getByTestId("approval-deny").click();
    // Denied: it never ran, so the one row says "Recusado" and there is no row of a tool that failed.
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "stopped");
    await expect(row(page)).toContainText("Recusado · Escrever negado.txt");
    await expect(card(page)).toHaveCount(0);
    await expect(botMessage(page, "Entendi, não escrevi o arquivo.")).toBeVisible();
    await row(page)
      .getByRole("button", { name: /Recusado/ })
      .click();
    await expect(row(page).getByTestId("approval-detail")).toContainText("Você recusou");
    await expect(row(page).getByTestId("approval-denial")).toHaveCount(0);
    await expect(row(page).getByTestId("action-output")).toHaveCount(0);
    // No reason was sent; the file was not written.
    const [denied] = await world.api.approvals.list({
      botId: await botId(world, "Negador"),
      status: "denied",
    });
    expect(denied?.reason ?? null).toBeNull();
    const events = await world.api.runs.events(denied?.runId as string, { limit: 500 });
    expect(JSON.stringify(events.items)).not.toContain('"outcome":"ok"');
  });

  test("approve and always allow: the choice is explained, the rule shows in settings, and the next call does not ask", async ({
    page,
  }) => {
    await openWithBot(page, world, "Permissivo");
    await send(page, "CASE-ALWAYS escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    // The chevron opens the menu; "Precisa de aprovação" starts checked.
    await card(page).getByTestId("approval-more").click();
    const needs = page.getByTestId("approval-needs");
    await expect(needs).toHaveAttribute("aria-checked", "true");
    // Turning it off makes Aprovar create the rule, and the card says exactly which one.
    await needs.click();
    const sentence = card(page).getByTestId("always-sentence");
    await expect(sentence).toContainText("o bot Permissivo");
    await expect(sentence).toContainText("path = “sempre.txt”");
    await expect(sentence).toContainText("content = “pode sempre”");
    await expect(card(page).getByTestId("approval-approve")).toHaveText("Aprovar e permitir");
    await card(page).getByTestId("approval-more").click();
    await page.getByTestId("approval-needs").click();
    await expect(sentence).toHaveCount(0);
    // "Sempre permitir isto, neste bot": approves and creates the rule in one click.
    await card(page).getByTestId("approval-more").click();
    await page.getByTestId("always-bot-exact").click();
    await expect(botMessage(page, "Primeiro arquivo escrito.")).toBeVisible();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
    // The row says it created a rule.
    await row(page)
      .getByRole("button", { name: /Aprovado/ })
      .click();
    await expect(row(page).getByTestId("approval-rule")).toContainText(
      "Libera Escrever arquivo para o bot Permissivo",
    );
    // The next call, the same one, goes through without a card.
    await send(page, "CASE-AGAIN agora faça de novo");
    await expect(botMessage(page, "Segundo arquivo escrito, sem perguntar.")).toBeVisible();
    // Still one row per call: the first one (approved), the second one (a rule let it through, no card).
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).toHaveCount(2);
    // (the first call belongs to an earlier run, whose events are not loaded: the approval alone says "Aprovado")
    await expect(row(page).first()).toContainText("Aprovado · Escrever sempre.txt");
    await expect(row(page).last()).toContainText("Concluído");
    await expect(row(page).last()).not.toContainText("Aprovado");
    expect(
      await world.api.approvals.list({ botId: await botId(world, "Permissivo") }),
    ).toHaveLength(1);
    // The rule is in the settings, in plain language, and can be deleted there.
    await openSettings(page, "Aprovações");
    const ruleRow = page.getByTestId("rule-row").filter({ hasText: "Permissivo" });
    await expect(ruleRow).toHaveCount(1);
    await expect(ruleRow.getByTestId("rule-sentence")).toContainText(
      "Libera Escrever arquivo para o bot Permissivo quando o campo path é exatamente “sempre.txt” e o campo content é exatamente “pode sempre”.",
    );
    await expect(ruleRow).toContainText("Criada num cartão");
    await ruleRow.getByTestId("rule-delete").click();
    await page.getByTestId("rule-delete-confirm").click();
    await expect(page.getByTestId("rule-row").filter({ hasText: "Permissivo" })).toHaveCount(0);
    expect(
      (await world.api.rules.list()).filter((r) => r.botId === null || r.createdBy === "approval"),
    ).toHaveLength(0);
  });

  test("rules: create a forbidding rule, edit it, see it work (no card, the bot is told), delete it", async ({
    page,
  }) => {
    await openWithBot(page, world, "Regrado");
    await openSettings(page, "Aprovações");
    await expect(page.getByTestId("rules-card")).toContainText(
      "Quem proíbe vale mais do que quem libera",
    );
    await page.getByTestId("rule-new").click();
    await page.getByTestId("rule-effect-deny").click();
    await page.getByTestId("rule-bot").selectOption({ label: "Regrado" });
    await page.getByTestId("rule-tool").selectOption("write_file");
    await page.getByRole("button", { name: "Adicionar condição" }).click();
    const condition = page.getByTestId("rule-condition");
    await condition.getByLabel("Campo dos argumentos (ex.: command)").fill("path");
    await condition.getByLabel("Como comparar").selectOption("starts_with");
    await condition.getByLabel("Valor").fill("proibido/");
    await expect(page.getByTestId("rule-preview")).toContainText(
      "Proíbe Escrever arquivo para o bot Regrado quando o campo path começa com “proibido/”.",
    );
    await page.getByTestId("rule-save").click();
    const row = page.getByTestId("rule-row").filter({ hasText: "Regrado" });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-effect", "deny");
    // Edit: the note.
    await row.getByTestId("rule-edit").click();
    await page.getByLabel("Anotação (opcional)").fill("a pasta proibido/ é só minha");
    await page.getByTestId("rule-save").click();
    await expect(row).toContainText("a pasta proibido/ é só minha");
    expect((await world.api.rules.list())[0]?.note).toBe("a pasta proibido/ é só minha");
    // It works: the call is refused by the rule, with no card, and the bot is told and goes on.
    await page.getByTestId("bot-item").filter({ hasText: "Regrado" }).click();
    await send(page, "CASE-RULEDENY escreva em proibido/");
    await expect(botMessage(page, "A regra não deixou eu escrever lá.")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    const runs = await world.api.runs.list({ botId: await botId(world, "Regrado") });
    const events = await world.api.runs.events(runs.items[0]?.id as string, { limit: 500 });
    expect(
      events.items.some(
        (e) =>
          e.type === "policy_checked" &&
          e.payload.outcome === "deny" &&
          e.payload.source === "rule",
      ),
    ).toBe(true);
    // Delete it.
    await openSettings(page, "Aprovações");
    await page
      .getByTestId("rule-row")
      .filter({ hasText: "Regrado" })
      .getByTestId("rule-delete")
      .click();
    await page.getByTestId("rule-delete-confirm").click();
    await expect(page.getByTestId("rule-row").filter({ hasText: "Regrado" })).toHaveCount(0);
    expect(await world.api.rules.list()).toHaveLength(0);
  });

  test("decided somewhere else: the click gets a graceful answer and the card shows how it stands; a cancelled run cancels its card", async ({
    page,
  }) => {
    await openWithBot(page, world, "Concorrente");
    await send(page, "CASE-APPROVE escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    const [served] = await world.api.approvals.list({
      status: "pending",
      botId: await botId(world, "Concorrente"),
    });
    // Someone else (the phone, the terminal) decides just before this click reaches the server.
    await page.route("**/v1/approvals/*/decision", async (route) => {
      if (route.request().method() === "POST") {
        await world.api.approvals.decide(served?.id as string, {
          decision: "deny",
          reason: "neguei no terminal",
        });
      }
      await route.continue();
    });
    await card(page).getByTestId("approval-approve").click();
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "já tinha sido decidido em outro lugar: recusado" }),
    ).toBeVisible();
    // The call was refused: ONE row, stopped, "Recusado"; the run went on (the script's next line).
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "stopped");
    await expect(row(page)).toContainText("Recusado · Escrever aprovado.txt");
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).not.toContainText("Concluído");
    // A reason given by another client (the API still takes one) is shown when the row opens.
    await row(page)
      .getByRole("button", { name: /Recusado/ })
      .click();
    await expect(row(page).getByTestId("approval-denial")).toContainText("neguei no terminal");
    await page.unroute("**/v1/approvals/*/decision");
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();

    // A card of a run that is cancelled is cancelled too.
    await freshBot(world, "Cancelado");
    await page.reload();
    await selectBot(page, "Cancelado");
    await send(page, "CASE-APPROVE escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    const [open] = await world.api.approvals.list({
      status: "pending",
      botId: await botId(world, "Cancelado"),
    });
    await world.api.runs.cancel(open?.runId as string);
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "stopped");
    await expect(row(page)).toContainText("Cancelado · Escrever aprovado.txt");
    await expect(card(page)).toHaveCount(0);
  });

  test("long content is collapsed with a button, and the whole card works from the keyboard", async ({
    page,
  }) => {
    await openWithBot(page, world, "Teclista");
    await send(page, "CASE-BIGARGS escreva o arquivo longo");
    const pending = card(page);
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    const content = pending.getByTestId("arg-value").nth(1);
    await expect(content).toContainText("linha 8 do arquivo longo");
    await expect(content).not.toContainText("linha 30 do arquivo longo");
    const more = pending.getByRole("button", { name: /Mostrar tudo \(mais 22 linhas\)/ });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // The card has the focus; Tab goes into it, in reading order, and reaches every button.
    await expect(pending).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(content).toContainText("linha 30 do arquivo longo");
    await page.keyboard.press("Tab");
    await expect(pending.getByTestId("approval-deny")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pending.getByTestId("approval-approve")).toBeFocused();
    await page.keyboard.press("Tab");
    const chevron = pending.getByTestId("approval-more");
    await expect(chevron).toBeFocused();
    // The menu of the chevron: Enter opens it with the focus on the first item, arrows move, Esc closes.
    await page.keyboard.press("Enter");
    const items = page.getByRole("menu").locator('[role^="menuitem"]');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await expect(items.last()).toContainText("Gerenciar regras");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(chevron).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(pending.getByTestId("approval-approve")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(botMessage(page, "Arquivo longo escrito.")).toBeVisible();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
  });

  test("'Gerenciar regras' in the menu opens Configurações > Aprovações", async ({ page }) => {
    await openWithBot(page, world, "Gerente");
    await send(page, "CASE-APPROVE escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await card(page).getByTestId("approval-more").click();
    await page.getByTestId("approval-manage-rules").click();
    await expect(page.getByRole("tab", { name: "Aprovações" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("rules-card")).toBeVisible();
    // Nothing is left waiting for the other tests: approve it from Configurações (it lists the pending cards).
    await page.getByTestId("settings-pending-approvals").getByTestId("approval-approve").click();
    await expect(page.getByTestId("settings-pending-approvals")).toContainText(
      "Nenhuma aprovação esperando",
    );
  });

  test("Pendências lists the card with the same buttons, and a decision there is a decision in the chat", async ({
    page,
  }) => {
    await openWithBot(page, world, "Pendente");
    await send(page, "CASE-APPROVE escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: /Pendências/ }).click();
    const item = page.getByTestId("pending-approval");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Pendente");
    await expect(item.getByTestId("arg-value").first()).toHaveText("aprovado.txt");
    await item.getByTestId("approval-approve").click();
    await expect(page.getByTestId("pending-approval")).toHaveCount(0);
    await expect(page.getByText("Nenhuma aprovação")).toBeVisible();
    await botItem(page, "Pendente").click();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();
  });
});
