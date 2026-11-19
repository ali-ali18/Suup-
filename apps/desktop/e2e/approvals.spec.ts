import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, freshBot, openWithBot, selectBot, send } from "./helpers.js";

// Phase 3 in the browser: the approval card (approve, deny with a reason, always allow, decided
// elsewhere, cancelled), the permanent rules, and the secure form of a secret request. Everything
// runs against the real server with the scripted provider: nothing is mocked.

const card = (page: Page) => page.getByTestId("approval-card");
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
    const [served] = await world.api.approvals.list({ status: "pending" });
    await expect(pending).toContainText(served?.summary ?? "?");
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
    await expect(pending.getByTestId("approval-reason")).toBeDisabled();
    // Confirmed: one line, "Aprovado · ...", closed; the run goes on and the bot says so.
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(card(page)).toContainText(`Aprovado · ${served?.summary ?? "?"}`);
    await expect(card(page).getByRole("button", { name: /Aprovado/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();
    await expect(
      page.getByTestId("action-card").filter({ hasText: "Escrever aprovado.txt" }),
    ).toContainText("Concluído");
    await page.unroute("**/v1/approvals/*/decision");
    // Expands on click and shows what ran, and collapses again.
    await card(page)
      .getByRole("button", { name: /Aprovado/ })
      .click();
    await expect(card(page).getByRole("region")).toContainText("Você aprovou");
    await expect(card(page).getByTestId("arg-value").first()).toHaveText("aprovado.txt");
    await card(page)
      .getByRole("button", { name: /Aprovado/ })
      .click();
    await expect(card(page).getByRole("region")).toHaveCount(0);
    // Nothing waits any more: the badge, the counter and the avatar went back.
    await expect(botItem(page, "Aprovador").getByTestId("bot-badge")).toHaveCount(0);
    await expect(page.getByTestId("pending-counter")).toHaveCount(0);
    // After a reload the card is still there, decided (it comes from the server, not from memory).
    await page.reload();
    await botItem(page, "Aprovador").click();
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(card(page)).toContainText("Aprovado ·");
  });

  test("deny with a reason: the bot is told, goes on and says so; the card keeps the reason", async ({
    page,
  }) => {
    await openWithBot(page, world, "Negador");
    await send(page, "CASE-DENY escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await card(page).getByTestId("approval-reason").fill("não escreva isso agora");
    await card(page).getByTestId("approval-deny").click();
    await expect(card(page)).toHaveAttribute("data-state", "stopped");
    await expect(card(page)).toContainText("Negado ·");
    await expect(botMessage(page, "Entendi, não escrevi o arquivo.")).toBeVisible();
    await card(page)
      .getByRole("button", { name: /Negado/ })
      .click();
    await expect(card(page).getByTestId("approval-denial")).toContainText("não escreva isso agora");
    await expect(card(page).getByTestId("approval-detail")).toContainText("Você negou");
    // The bot read the reason: it is in the result of the call, in the log of the run.
    const [denied] = await world.api.approvals.list({
      botId: await botId(world, "Negador"),
      status: "denied",
    });
    expect(denied?.reason).toBe("não escreva isso agora");
    const events = await world.api.runs.events(denied?.runId as string, { limit: 500 });
    const result = events.items.find((e) => e.type === "tool_result" && e.payload.isError === true);
    expect(JSON.stringify(result?.payload)).toContain("não escreva isso agora");
    // The file was not written.
    expect(JSON.stringify(events.items)).not.toContain('"outcome":"ok"');
  });

  test("approve and always allow: the choice is explained, the rule shows in settings, and the next call does not ask", async ({
    page,
  }) => {
    await openWithBot(page, world, "Permissivo");
    await send(page, "CASE-ALWAYS escreva o arquivo");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await card(page).getByTestId("approval-always-toggle").click();
    await expect(card(page).getByTestId("always-scope-bot")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const sentence = card(page).getByTestId("always-sentence");
    await expect(sentence).toContainText("o bot Permissivo");
    await expect(sentence).toContainText("path = “sempre.txt”");
    await expect(sentence).toContainText("content = “pode sempre”");
    await card(page).getByTestId("always-match-any").click();
    await expect(sentence).toContainText("qualquer uso de Escrever arquivo");
    await card(page).getByTestId("always-match-exact").click();
    await card(page).getByTestId("approval-always-confirm").click();
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(botMessage(page, "Primeiro arquivo escrito.")).toBeVisible();
    // The card says it created a rule.
    await card(page)
      .getByRole("button", { name: /Aprovado/ })
      .click();
    await expect(card(page).getByTestId("approval-rule")).toContainText(
      "Libera Escrever arquivo para o bot Permissivo",
    );
    // The next call, the same one, goes through without a card.
    await send(page, "CASE-AGAIN agora faça de novo");
    await expect(botMessage(page, "Segundo arquivo escrito, sem perguntar.")).toBeVisible();
    await expect(card(page)).toHaveCount(1);
    expect(
      await world.api.approvals.list({ botId: await botId(world, "Permissivo") }),
    ).toHaveLength(1);
    // The rule is in the settings, in plain language, and can be deleted there.
    await openSettings(page, "Aprovações");
    const row = page.getByTestId("rule-row").filter({ hasText: "Permissivo" });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("rule-sentence")).toContainText(
      "Libera Escrever arquivo para o bot Permissivo quando o campo path é exatamente “sempre.txt” e o campo content é exatamente “pode sempre”.",
    );
    await expect(row).toContainText("Criada num cartão");
    await row.getByTestId("rule-delete").click();
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
        .filter({ hasText: "já tinha sido decidido em outro lugar: negado" }),
    ).toBeVisible();
    await expect(card(page)).toHaveAttribute("data-state", "stopped");
    await expect(card(page)).toContainText("Negado ·");
    await expect(card(page).getByTestId("approval-error")).toHaveCount(0);
    await page.unroute("**/v1/approvals/*/decision");
    // The call was refused: the run went on (the script's next line), and the call is a failed card.
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();
    await expect(page.getByTestId("action-card")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("action-card")).not.toContainText("Concluído");

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
    await expect(card(page)).toHaveAttribute("data-state", "stopped");
    await expect(card(page)).toContainText("Cancelado ·");
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
    await expect(pending.getByTestId("approval-reason")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pending.getByTestId("approval-deny")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pending.getByTestId("approval-always-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(pending.getByTestId("approval-approve")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(botMessage(page, "Arquivo longo escrito.")).toBeVisible();
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
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(botMessage(page, "Escrevi o arquivo aprovado.")).toBeVisible();
  });
});
