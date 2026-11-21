import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  botItem,
  closeSettings,
  freshBot,
  openSettings,
  openWithBot,
  selectBot,
  send,
} from "./helpers.js";

// Phase 3 in the browser: the approval card (approve, deny (one click), decided elsewhere,
// cancelled; a normal action has ONLY Recusar and Aprovar), the old exact rules (read and remove
// in settings; the written rules and the mode are in auto-review.spec.ts), and the secure form of a secret request. The message card (the split button) is in
// vault-connectors.spec.ts, because only a connector tool the user marked is one. Everything
// runs against the real server with the scripted provider: nothing is mocked.

// The decision card (waiting for you) and the row of a call (what the bot did, an approval merged in).
const card = (page: Page) => page.getByTestId("approval-card");
const row = (page: Page) => page.getByTestId("action-card");
const botMessage = (page: Page, text: string) =>
  page.getByTestId("message-bot").filter({ hasText: text });

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
    await expect(pending.locator('[data-testid="decision-category"]')).toHaveText("Arquivo");
    await expect(pending.getByTestId("approval-risk")).toHaveText(/Externa ou irreversível/);
    // Border, radius and reading width of the shared chrome.
    await expect(pending).toHaveCSS("border-top-width", "1px");
    await expect(pending).toHaveCSS("border-top-left-radius", "24px");
    expect((await pending.boundingBox())?.width ?? 0).toBeLessThanOrEqual(700);
    // A normal action: ONLY the plain text Recusar and the pill Aprovar. No split button, no menu.
    await expect(pending.getByRole("button", { name: /Mostrar tudo/ })).toHaveCount(0);
    expect(await pending.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    await expect(pending.getByTestId("approval-more")).toHaveCount(0);
    await expect(pending.locator('[data-testid="split-button"]')).toHaveCount(0);
    await expect(pending.locator('[aria-haspopup="menu"]')).toHaveCount(0);
    await expect(pending).not.toContainText(/sempre permitir/i);
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
    const chevron = resolved.locator('[data-testid="action-chevron"]');
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

  test("approved after the card waited for hours: the row says so, the bot resumes the old task and asks again, and the identical call needs no second card", async ({
    page,
  }) => {
    await openWithBot(page, world, "Retardatario");
    await send(page, "CASE-STALE escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    // The card has been waiting for 5 hours (the limit is 1 hour): forced in the database.
    const [pending] = await world.api.approvals.list({
      botId: await botId(world, "Retardatario"),
      status: "pending",
    });
    await world.db
      .sql`update approvals set created_at = now() - interval '5 hours' where id = ${pending?.id as string}`;
    expect(await card(page).getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    await card(page).getByTestId("approval-approve").click();
    await expect(botMessage(page, "Escrevi o arquivo tardio.")).toBeVisible();
    // One card only: the second, identical call ran on the grant. The first row is the old card.
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).toHaveCount(2);
    await expect(row(page).first()).toContainText("Aprovado depois de 5 h · Escrever tardio.txt");
    await expect(row(page).first().getByRole("button")).toHaveCount(1);
    await expect(row(page).last()).toContainText("Escrever tardio.txt");
    await expect(row(page).last()).not.toContainText("Aprovado");
    await row(page).first().getByRole("button").click();
    await expect(row(page).first().getByTestId("approval-detail")).toContainText(
      "Você aprovou depois de 5 h: a ação não rodou na hora",
    );
    const approvals = await world.api.approvals.list({ botId: pending?.botId as string });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "approved", stale: true });
    const events = (await world.api.runs.events(pending?.runId as string, { limit: 500 })).items;
    expect(events.filter((e) => e.type === "approval_stale")).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval_grant_used")).toHaveLength(1);
    // After a reload the row is the same, read from the server.
    await page.reload();
    await botItem(page, "Retardatario").click();
    await expect(row(page).first()).toContainText("Aprovado depois de 5 h · Escrever tardio.txt");
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

  test("a normal card makes no rule; an exact rule (the advanced layer) lets the next call through and is only read and removed in settings", async ({
    page,
  }) => {
    await openWithBot(page, world, "Permissivo");
    await send(page, "CASE-ALWAYS escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    expect(await card(page).getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    await card(page).getByTestId("approval-approve").click();
    await expect(botMessage(page, "Primeiro arquivo escrito.")).toBeVisible();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
    // Approving created nothing behind the user's back.
    await row(page)
      .getByRole("button", { name: /Aprovado/ })
      .click();
    await expect(row(page).getByTestId("approval-rule")).toHaveCount(0);
    expect((await world.api.rules.list()).filter((r) => r.createdBy === "approval")).toHaveLength(
      0,
    );
    // Nothing exact exists: the settings page has no row for them.
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("rules-exact")).toHaveCount(0);
    await closeSettings(page);
    // An exact rule, made through the API (the app has no way to write one any more): equality on two fields.
    const exact = await world.api.rules.create({
      tool: "write_file",
      effect: "allow",
      botId: await botId(world, "Permissivo"),
      matchers: [
        { field: "path", value: "sempre.txt" },
        { field: "content", value: "pode sempre" },
      ],
    });
    // The same call goes through without a card.
    await selectBot(page, "Permissivo");
    await send(page, "CASE-AGAIN agora faça de novo");
    await expect(botMessage(page, "Segundo arquivo escrito, sem perguntar.")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).toHaveCount(2);
    await expect(row(page).last()).not.toContainText("Aprovado");
    expect(
      await world.api.approvals.list({ botId: await botId(world, "Permissivo") }),
    ).toHaveLength(1);
    // Settings: not in the main view; one quiet row at the end with the count, opening the old list.
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("rule-row")).toHaveCount(0);
    await expect(page.getByTestId("settings-screen")).not.toContainText("sempre permitir");
    const quiet = page.getByTestId("rules-exact");
    await expect(quiet).toContainText("Regras exatas (avançado)");
    await expect(quiet).toContainText("1 regra");
    await page.getByTestId("rules-exact-open").click();
    const list = page.getByTestId("rules-exact-list");
    const ruleRow = list.getByTestId("rule-row").filter({ hasText: "Permissivo" });
    await expect(ruleRow).toHaveCount(1);
    await expect(ruleRow.getByTestId("rule-sentence")).toContainText(
      "Libera Escrever arquivo para o bot Permissivo quando o campo path é exatamente “sempre.txt” e o campo content é exatamente “pode sempre”.",
    );
    // Read and remove only: nothing here makes or edits a rule.
    await expect(page.getByTestId("rule-edit")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Adicionar condição" })).toHaveCount(0);
    await ruleRow.getByTestId("rule-delete").click();
    await page.getByTestId("rule-delete-confirm").click();
    await expect(list.getByTestId("rule-row")).toHaveCount(0);
    expect(await world.api.rules.list()).toHaveLength(0);
    expect(exact.id).toBeTruthy();
    await page.getByTestId("rules-exact-close").click();
    // With none left, the row is gone.
    await expect(page.getByTestId("rules-exact")).toHaveCount(0);
    await closeSettings(page);
  });

  test("an exact deny rule still refuses the call (no card, the bot is told), and it is removed from the advanced list", async ({
    page,
  }) => {
    await openWithBot(page, world, "Regrado");
    await world.api.rules.create({
      tool: "write_file",
      effect: "deny",
      botId: await botId(world, "Regrado"),
      matchers: [{ field: "path", value: "proibido/segredo.txt" }],
      note: "este arquivo é só meu",
    });
    // It works: the call is refused by the rule, with no card, and the bot is told and goes on.
    await send(page, "CASE-RULEDENY escreva em proibido/segredo.txt");
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
    // It is not a written rule: the written groups are empty, and the advanced row has it.
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("written-rule")).toHaveCount(0);
    await expect(page.getByTestId("rules-exact")).toContainText("1 regra");
    await page.getByTestId("rules-exact-open").click();
    const ruleRow = page.getByTestId("rule-row").filter({ hasText: "Regrado" });
    await expect(ruleRow).toHaveAttribute("data-effect", "deny");
    await expect(ruleRow).toContainText("este arquivo é só meu");
    await ruleRow.getByTestId("rule-delete").click();
    await page.getByTestId("rule-delete-confirm").click();
    await expect(page.getByTestId("rule-row")).toHaveCount(0);
    expect(await world.api.rules.list()).toHaveLength(0);
    await page.getByTestId("rules-exact-close").click();
    await closeSettings(page);
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
    // Nothing comes after Aprovar: there is no menu on a normal card.
    await page.keyboard.press("Enter");
    await expect(botMessage(page, "Arquivo longo escrito.")).toBeVisible();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toHaveAttribute("data-state", "done");
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
