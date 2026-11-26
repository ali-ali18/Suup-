import { expect, type Locator, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { closeSettings, openSettings, openWithBot, selectBot, send } from "./helpers.js";

// Auto-review in the browser, against the real server and the scripted provider: the mode and the
// rules the user WRITES in Configurações > Permissões (one of each kind: create, edit, switch, remove),
// a call a "Nunca permitir" rule refused (no card and no row in the chat), and a card that
// says why the reviewer sent it to you. The reviewer's answers are the `autoReview` section of the
// scripts; what the model would decide on its own is measured elsewhere (evals/).

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const shell = (command: string) => ({ name: "shell", args: { command } });
const verdict = (decision: string, ruleId: string | null, reason: string) =>
  s({ calls: [{ name: "review_call", args: { decision, ruleId, reason } }] });

const NEVER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLOCK_TEXT = "rodar echo nao-rode";
const ASK_REASON = "Não está claro se você quer rodar isto.";

const yes = (answer: string, reason: string) =>
  s({ calls: [{ name: "chat_verdict", args: { answer, reason } }] });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-CHATYES",
        agent: [s({ calls: [shell("echo pelo-chat")] }), s({ text: "Rodei pelo chat." })],
        autoReview: [verdict("ask", null, ASK_REASON)],
        chatApproval: [yes("yes", "Um sim claro a este pedido.")],
      },
      {
        whenObjectiveContains: "CASE-CHATNO",
        agent: [s({ calls: [shell("echo sem-chat")] }), s({ text: "Rodei só com o clique." })],
        autoReview: [verdict("ask", null, ASK_REASON)],
        chatApproval: [yes("unclear", "É uma pergunta, não um sim.")],
      },
      {
        whenObjectiveContains: "CASE-BLOCK",
        agent: [s({ calls: [shell("echo nao-rode")] }), s({ text: "Entendi, não vou rodar." })],
        autoReview: [verdict("block", NEVER_ID, "A regra proíbe isto.")],
      },
      {
        whenObjectiveContains: "CASE-ASK",
        agent: [s({ calls: [shell("echo talvez")] }), s({ text: "Rodei, com a sua licença." })],
        autoReview: [verdict("ask", null, ASK_REASON)],
      },
    ],
  },
};

const SHOTS = "screenshots/1440x900@2x";
const card = (page: Page) => page.getByTestId("approval-card");
const row = (page: Page) => page.getByTestId("action-card");
const botMessage = (page: Page, text: string) =>
  page.getByTestId("message-bot").filter({ hasText: text });

/** Opens one of the app's dropdowns and clicks the option whose name starts with `label`. */
async function pick(page: Page, dropdown: Locator, label: string): Promise<void> {
  await dropdown.click();
  await page.getByRole("option").filter({ hasText: label }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function botId(world: World, name: string): Promise<string> {
  const bots = await world.api.bots.list();
  return bots.find((b) => b.name === name)?.id as string;
}

test.describe("Auto-review: the mode, the rules you write, and what the chat shows", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS, autoReviewModel: "model-x" });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("Permissões: the mode, and one written rule of each kind (create, edit, switch, remove) with the server as the judge", async ({
    page,
  }) => {
    await openWithBot(page, world, "Escritor");
    await openSettings(page, "Permissões");
    const body = page.getByTestId("settings-panel-permissions");

    // The mode: Auto-review (the server's), with a reviewer available, so no note about it.
    const mode = page.getByTestId("approval-mode");
    await expect(mode).toHaveText("Auto-review");
    await expect(page.getByTestId("reviewer-unavailable")).toHaveCount(0);
    await expect(body.getByTestId("approval-mode-description")).toContainText(
      "só pergunta quando precisa",
    );
    // Order of the groups, and no native select anywhere.
    await expect(body.locator("h3")).toHaveText([
      "Aprovações",
      "Nunca permitir",
      "Sempre perguntar",
      "Permitir sem perguntar",
      "Conectores",
    ]);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByTestId("rules-exact")).toHaveCount(0);

    // The mode's menu: both choices with their one line each.
    await mode.click();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText("Auto-review");
    await expect(options.nth(0)).toContainText("só pergunta quando precisa");
    await expect(options.nth(1)).toContainText("Perguntar tudo");
    await expect(options.nth(1)).toContainText("Toda ação que não é só leitura pede aprovação");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/25a-config-modo-dropdown.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.getByTestId("settings-screen")).toBeVisible();

    // A rule of each kind, written. The first dialog is shot empty and filled.
    const kinds = [
      {
        kind: "never",
        text: "Apagar a pasta notas",
        placeholder: "Apagar a pasta notas",
        title: "Nunca permitir",
        bot: "Escritor",
      },
      {
        kind: "ask",
        text: "Qualquer coisa que gaste dinheiro",
        placeholder: "Qualquer coisa que gaste dinheiro",
        title: "Sempre perguntar",
        bot: undefined,
      },
      {
        kind: "allow",
        text: "E-mails para minha equipe em acme.com",
        placeholder: "E-mails para minha equipe em acme.com",
        title: "Permitir sem perguntar",
        bot: undefined,
      },
    ] as const;
    for (const [index, k] of kinds.entries()) {
      await page.getByTestId(`rule-new-${k.kind}`).click();
      const dialog = page.getByRole("dialog", { name: k.title });
      await expect(dialog).toBeVisible();
      const text = dialog.getByTestId("written-rule-text");
      await expect(text).toHaveAttribute("placeholder", k.placeholder);
      await expect(dialog.getByLabel("Aplica-se a")).toBeVisible();
      await expect(dialog).toContainText("Diga qual é a ação e quem ou o que ela afeta.");
      await expect(dialog).toContainText("Para qual bot");
      await expect(dialog.getByTestId("written-rule-bot")).toHaveText("Todos os bots");
      await expect(dialog.getByTestId("written-rule-counter")).toHaveCount(0);
      // The only controls: the text, the bot dropdown, Cancelar and the add button, off while empty.
      await expect(dialog.getByRole("textbox")).toHaveCount(1);
      await expect(dialog.getByRole("button", { name: "Adicionar regra" })).toBeDisabled();
      if (index === 0) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${SHOTS}/25b-config-regra-vazia.png` });
      }
      await text.fill(k.text);
      if (k.bot !== undefined) await pick(page, dialog.getByTestId("written-rule-bot"), k.bot);
      await expect(dialog.getByRole("button", { name: "Adicionar regra" })).toBeEnabled();
      if (index === 0) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${SHOTS}/25c-config-regra-preenchida.png` });
      }
      await dialog.getByTestId("written-rule-save").click();
      await expect(dialog).toHaveCount(0);
      const group = page.getByTestId(`rules-${k.kind}`);
      await expect(group.getByTestId("written-rule")).toHaveCount(1);
      await expect(group.getByTestId("written-rule-sentence")).toHaveText(k.text);
      await expect(group.getByTestId("written-rule-for")).toHaveText(k.bot ?? "Todos os bots");
    }
    // Against the real backend: exactly those three, with the kind, the text and the bot.
    const stored = await world.api.writtenRules.list();
    expect(stored.map((r) => [r.kind, r.text, r.enabled])).toEqual([
      ["never", "Apagar a pasta notas", true],
      ["ask", "Qualquer coisa que gaste dinheiro", true],
      ["allow", "E-mails para minha equipe em acme.com", true],
    ]);
    expect(stored[0]?.botId).toBe(await botId(world, "Escritor"));
    expect(stored[1]?.botId).toBeNull();
    await page.mouse.move(0, 0);
    await page.getByTestId("rules-never").scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/25-config-permissoes-modo-e-regras.png` });

    // Edit: only the sentence changes (the bot is fixed once written).
    const never = page.getByTestId("rules-never").getByTestId("written-rule");
    await never.getByTestId("written-rule-edit").click();
    const editDialog = page.getByRole("dialog", { name: "Editar regra" });
    await expect(editDialog.getByTestId("written-rule-text")).toHaveValue("Apagar a pasta notas");
    await expect(editDialog.getByTestId("written-rule-bot")).toBeDisabled();
    await editDialog
      .getByTestId("written-rule-text")
      .fill("Apagar qualquer arquivo da pasta notas");
    await editDialog.getByTestId("written-rule-save").click();
    await expect(never.getByTestId("written-rule-sentence")).toHaveText(
      "Apagar qualquer arquivo da pasta notas",
    );
    expect((await world.api.writtenRules.list())[0]?.text).toBe(
      "Apagar qualquer arquivo da pasta notas",
    );

    // The server is the judge of the length: its words are shown, the dialog stays open.
    await page.getByTestId("rule-new-ask").click();
    const long = page.getByRole("dialog", { name: "Sempre perguntar" });
    await long.getByTestId("written-rule-text").fill("x".repeat(501));
    await expect(long.getByTestId("written-rule-counter")).toHaveText("501/500");
    await long.getByTestId("written-rule-save").click();
    await expect(long.getByTestId("written-rule-error")).toBeVisible();
    await expect(long.getByTestId("written-rule-error")).not.toHaveText("");
    expect(await world.api.writtenRules.list()).toHaveLength(3);
    await long.getByRole("button", { name: "Cancelar" }).click();
    await expect(long).toHaveCount(0);

    // The switch: off on the server and after a reload.
    const ask = page.getByTestId("rules-ask").getByTestId("written-rule");
    await ask.getByTestId("written-rule-toggle").click();
    await expect(ask.getByTestId("written-rule-toggle")).toHaveAttribute("aria-checked", "false");
    await expect(ask.getByTestId("written-rule-for")).toContainText("desligada");
    expect((await world.api.writtenRules.list()).find((r) => r.kind === "ask")?.enabled).toBe(
      false,
    );
    await page.reload();
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("rules-ask").getByTestId("written-rule-toggle")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Remove: asks first; Cancelar keeps it, Remover deletes it on the server.
    const allow = page.getByTestId("rules-allow").getByTestId("written-rule");
    await allow.getByTestId("written-rule-delete").click();
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(allow).toHaveCount(1);
    await allow.getByTestId("written-rule-delete").click();
    await page.getByTestId("written-rule-delete-confirm").click();
    await expect(page.getByTestId("rules-allow").getByTestId("written-rule")).toHaveCount(0);
    expect((await world.api.writtenRules.list()).map((r) => r.kind)).toEqual(["never", "ask"]);

    // The mode: Perguntar tudo is kept by the server and still there after a reload; back again.
    await pick(page, page.getByTestId("approval-mode"), "Perguntar tudo");
    await expect(page.getByTestId("approval-mode")).toHaveText("Perguntar tudo");
    await expect(page.getByTestId("rules-allow")).toContainText("não são lidas");
    // The mode changes on the screen at once and is written after (PermissionsSettings): wait for
    // the server to hold the final value; it must get there, whatever the machine's speed.
    await expect.poll(async () => (await world.api.approvalSettings.get()).mode).toBe("ask_all");
    await page.reload();
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("approval-mode")).toHaveText("Perguntar tudo");
    await pick(page, page.getByTestId("approval-mode"), "Auto-review");
    await expect(page.getByTestId("approval-mode")).toHaveText("Auto-review");
    // The mode changes on the screen at once and is written after (PermissionsSettings): wait for
    // the server to hold the final value; it must get there, whatever the machine's speed.
    await expect
      .poll(async () => (await world.api.approvalSettings.get()).mode)
      .toBe("auto_review");
    await closeSettings(page);
    for (const rule of await world.api.writtenRules.list())
      await world.api.writtenRules.remove(rule.id);
  });

  test("Permissões: the limit for a card that waited too long is a Dropdown, kept by the server", async ({
    page,
  }) => {
    await openWithBot(page, world, "Paciente");
    await openSettings(page, "Permissões");
    const stale = page.getByTestId("approval-stale");
    await expect(stale).toHaveText("1 h");
    await expect(page.locator("select")).toHaveCount(0);
    await stale.click();
    await expect(page.getByRole("option")).toHaveText([
      "15 min",
      "1 h",
      "6 h",
      "1 dia",
      "1 semana",
    ]);
    await page.getByRole("option", { name: "6 h", exact: true }).click();
    await expect(stale).toHaveText("6 h");
    await expect
      .poll(async () => (await world.api.approvalSettings.get()).staleAfterMinutes)
      .toBe(360);
    // Still there after a reload (the server's, not the browser's); a value of another origin is added.
    await page.reload();
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("approval-stale")).toHaveText("6 h");
    await world.api.approvalSettings.update({ staleAfterMinutes: 90 });
    await page.reload();
    await openSettings(page, "Permissões");
    await expect(page.getByTestId("approval-stale")).toHaveText("90 min");
    await pick(page, page.getByTestId("approval-stale"), "1 h");
    await expect(page.getByTestId("approval-stale")).toHaveText("1 h");
    // Written after the screen changes (as above): wait for the server to hold it.
    await expect
      .poll(async () => (await world.api.approvalSettings.get()).staleAfterMinutes)
      .toBe(60);
    await closeSettings(page);
  });

  test("a call a 'Nunca permitir' rule refused leaves no card and no row in the chat: the bot only says it did not run, also after a reload", async ({
    page,
  }) => {
    await openWithBot(page, world, "Bloqueado");
    const mine = await botId(world, "Bloqueado");
    await world.db.sql`
      insert into written_rules (id, kind, text, bot_id)
      values (${NEVER_ID}, 'never', ${BLOCK_TEXT}, ${mine})`;
    await send(page, "CASE-BLOCK rode o comando");
    await expect(botMessage(page, "Entendi, não vou rodar.")).toBeVisible();
    // No card ever, and no row either: the call was refused, the chat shows only the bot's words
    // (the refusal and the rule's words are in the Inspector).
    await expect(card(page)).toHaveCount(0);
    await expect(row(page)).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/25d-chat-bloqueado-pela-regra.png` });
    expect(await world.api.approvals.list({ botId: mine })).toHaveLength(0);
    // The rule is still read from the server after a reload; the chat still shows no row.
    await world.api.writtenRules.update(NEVER_ID, { text: "rodar qualquer echo" });
    await page.reload();
    await selectBot(page, "Bloqueado");
    await expect(botMessage(page, "Entendi, não vou rodar.")).toBeVisible();
    await expect(row(page)).toHaveCount(0);
    await world.api.writtenRules.remove(NEVER_ID);
  });

  test("a card the reviewer sent to you says why in its one light line, with only Recusar and Aprovar", async ({
    page,
  }) => {
    await openWithBot(page, world, "Perguntado");
    await send(page, "CASE-ASK rode o comando");
    const pending = card(page);
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    await expect(pending.getByTestId("approval-why")).toHaveText(ASK_REASON);
    await expect(pending).toContainText("Rodar echo talvez");
    expect(await pending.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
    const [served] = await world.api.approvals.list({
      status: "pending",
      botId: await botId(world, "Perguntado"),
    });
    expect(served?.reviewReason).toBe(ASK_REASON);
    expect(served?.source).toBe("reviewer");
    await pending.focus();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/25e-cartao-motivo-da-revisao.png` });
    await pending.getByTestId("approval-approve").click();
    await expect(botMessage(page, "Rodei, com a sua licença.")).toBeVisible();
    await expect(row(page)).toHaveCount(0);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(card(page)).toContainText("Aprovado");
  });

  test("a clear yes written in the chat approves the one waiting card like a click, and the card says so", async ({
    page,
  }) => {
    await openWithBot(page, world, "Conversador");
    await send(page, "CASE-CHATYES rode o comando");
    await expect(card(page)).toHaveAttribute("data-state", "needs-action");
    await send(page, "CASE-CHATYES pode rodar");
    await expect(botMessage(page, "Rodei pelo chat.")).toBeVisible();
    const done = card(page);
    await expect(done).toHaveAttribute("data-state", "done");
    await expect(done).toContainText("Aprovado pelo chat");
    const [served] = await world.api.approvals.list({
      botId: await botId(world, "Conversador"),
      status: "approved",
    });
    expect(served?.decidedVia).toBe("chat");
    expect(served?.decidedMessageId).not.toBeNull();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${SHOTS}/25f-cartao-aprovado-pelo-chat.png` });
  });

  test("a message that is not a yes leaves the card where it is, and the click still works", async ({
    page,
  }) => {
    await openWithBot(page, world, "Duvidoso");
    await send(page, "CASE-CHATNO rode o comando");
    const pending = card(page);
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    await send(page, "CASE-CHATNO e se eu mudar de ideia?");
    await expect(page.getByTestId("message-user")).toHaveCount(2);
    await expect(pending).toHaveAttribute("data-state", "needs-action");
    await pending.getByTestId("approval-approve").click();
    await expect(botMessage(page, "Rodei só com o clique.")).toBeVisible();
    await expect(card(page)).toContainText("Aprovado");
    await expect(card(page)).not.toContainText("pelo chat");
  });
});
