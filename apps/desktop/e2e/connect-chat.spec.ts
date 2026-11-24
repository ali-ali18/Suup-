import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { connect, openWithBot, send, userBubbles } from "./helpers.js";

test.describe("connect and chat", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("a wrong token is refused with a message, the right one opens the app and lists the main bot", async ({
    page,
  }) => {
    await connect(page, world, "um-token-errado-um-token-errado-um-token-errado");
    await expect(page.getByTestId("connect-error")).toContainText("token");
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    // A server that is not there at all says so too.
    await page.getByLabel("Endereço do servidor").fill("http://127.0.0.1:9");
    await page.getByLabel("Token").fill(world.token);
    await page.getByRole("button", { name: "Conectar" }).click();
    await expect(page.getByTestId("connect-error")).toContainText(
      "Não consegui falar com o servidor",
    );
    // The right one.
    await page.getByLabel("Endereço do servidor").fill(world.serverUrl);
    await page.getByRole("button", { name: "Conectar" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("bot-item").filter({ hasText: "Principal" })).toBeVisible();
    await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Principal");
  });

  test("a tool call is a flat card: running, then collapsed; it expands in place with the command and its output", async ({
    page,
  }) => {
    await openWithBot(page, world, "Fluxo");
    await send(page, "CASE-ACTIONS faça as coisas");
    await expect(userBubbles(page).last()).toContainText("CASE-ACTIONS");
    // The indicator says what the bot is doing, from the real state: the plan step, then the tool.
    const indicator = page.getByTestId("working-indicator");
    await expect(indicator).toHaveAttribute("data-phrase", "Passo 1 de 2 · Preparar o ambiente");
    await expect(indicator).toHaveAttribute(
      "data-phrase",
      "Rodando o comando sleep 3; echo primeiro",
    );
    // While it works, the bot's face in the sidebar is the engine's "thinking"/"working" state.
    const entry = page.locator('[data-testid="bot-item"][data-bot="Fluxo"]');
    await expect(entry).toHaveAttribute("data-working", "true");
    const face = entry.locator("[data-mascot]");
    await expect(face).toHaveAttribute("data-state", /^(thinking|working)$/);
    await expect(face).toHaveAttribute("data-mode", "animated");
    // The card of the running tool: one row, with a spinner.
    const running = page.locator('[data-testid="action-card"][data-state="running"]');
    await expect(running).toContainText("Terminal");
    await expect(running).toContainText("Rodando · Rodar o comando sleep 3; echo primeiro");
    await expect(running.locator(".animate-spin")).toBeVisible();
    // When it is done, the card collapses to "Concluído · ..." with a chevron.
    const first = page.getByTestId("action-card").first();
    await expect(first).toHaveAttribute("data-state", "done");
    await expect(first).toContainText("Concluído · Rodar o comando sleep 3; echo primeiro");
    await expect(first.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    // Expanding shows it IN PLACE: the command and the output, as plain text on the card's own background.
    await first.getByRole("button").click();
    await expect(first.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    const region = first.getByRole("region");
    await expect(region).toContainText("$ sleep 3; echo primeiro");
    await expect(region.getByTestId("action-output")).toContainText("primeiro");
    const flat = await first.evaluate((card) => {
      const pre = card.querySelector("pre") as HTMLElement;
      const style = getComputedStyle(pre);
      return {
        cardBackground: getComputedStyle(card).backgroundColor,
        preBackground: style.backgroundColor,
        preBorder: style.borderTopWidth,
        prePadding: style.paddingTop,
        font: style.fontFamily,
      };
    });
    expect(flat.preBackground).toBe("rgba(0, 0, 0, 0)");
    expect(flat.preBorder).toBe("0px");
    expect(flat.font).toContain("JetBrains Mono");
    expect(flat.cardBackground).toBe("rgb(30, 30, 30)");
    // The face leaves the working state when the bot stops (a happy moment, then rest); the indicator goes.
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Terminei as cinco ações." }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
    await expect(entry).toHaveAttribute("data-working", "false");
    await expect(entry.locator("[data-mascot] svg")).toBeVisible();
    await expect(entry.locator("[data-mascot]")).toHaveAttribute("data-state", /^(done|idle)$/);
    // Five finished cards: the latest three stay, the two older ones fold into "Mais 2 ações".
    await expect(page.getByTestId("action-card")).toHaveCount(3);
    const fold = page.getByTestId("action-fold");
    await expect(fold).toContainText("Mais 2 ações");
    await expect(fold.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    // What was expanded before the fold formed is still expanded when the fold opens (state by call id).
    await fold.getByRole("button").click();
    await expect(fold.getByTestId("action-card")).toHaveCount(2);
    await expect(fold.getByTestId("action-card").first().getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(fold.getByTestId("action-card").nth(1).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The card is flat like the bot's bubble: the same background.
    const bubble = await page
      .getByTestId("message-bot")
      .filter({ hasText: "Terminei as cinco ações." })
      .locator('[data-testid="bubble-bot"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bubble).toBe(flat.cardBackground);
    // Collapses again, from the keyboard.
    const toggle = fold.getByTestId("action-card").first().getByRole("button");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("files: an edit expands to a plain-text diff, with no coloured blocks", async ({ page }) => {
    await openWithBot(page, world, "Arquivos");
    await send(page, "CASE-FLOW faça o arquivo");
    const edit = page.getByTestId("action-card").filter({ hasText: "Arquivo" });
    await expect(edit).toContainText("Concluído · Editar ola.txt", { timeout: 60_000 });
    await edit.getByRole("button").click();
    const diff = edit.getByTestId("diff");
    await expect(diff).toContainText("- feito");
    await expect(diff).toContainText("+ tudo certo");
    expect(
      await diff
        .locator('[data-testid="action-line-removed"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await diff
        .locator('[data-testid="action-line-added"]')
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(74, 222, 128)");
    await expect(
      page
        .getByTestId("message-bot")
        .filter({ hasText: "Criei o arquivo ola.txt e conferi o conteúdo." }),
    ).toBeVisible({ timeout: 60_000 });
    // The plan is not a card: it shows in the indicator while the work goes on.
    await expect(page.getByTestId("action-card")).toHaveCount(2);
  });

  test("a question with one choice is a card: click an option, it answers; the card stays, dimmed, with the choice marked", async ({
    page,
  }) => {
    await openWithBot(page, world, "Cores");
    await send(page, "CASE-OPTIONS escolha uma cor");
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    await expect(card).toContainText("Qual cor você prefere?");
    await expect(card.getByTestId("question-option")).toHaveText([
      "AAzulA cor do mar",
      "BVerdeA cor da mata",
    ]);
    await expect(card.getByRole("radiogroup")).toBeVisible();
    // While it is open the composer invites a free answer, and the bot is marked as having a doubt.
    await expect(page.getByLabel("Mensagem", { exact: true })).toHaveAttribute(
      "placeholder",
      "Digite sua resposta ou fale sobre outra coisa",
    );
    await expect(page.locator('[data-testid="bot-item"][data-bot="Cores"]')).toHaveAttribute(
      "data-chip",
      "doubt",
    );
    await expect(page.getByTestId("pending-counter")).toBeVisible();
    // The card is at the same left edge as the bot's other messages, and no wider than 700px.
    expect((await card.boundingBox())?.width ?? 999).toBeLessThanOrEqual(701);
    await card.getByTestId("question-option").filter({ hasText: "Verde" }).click();
    await expect(userBubbles(page).last()).toContainText("Verde");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Anotei a sua escolha e terminei." }),
    ).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card.locator('[data-testid="question-option"][aria-checked="true"]')).toHaveText(
      "BVerdeA cor da mata",
    );
    await expect(page.getByLabel("Mensagem", { exact: true })).toHaveAttribute(
      "placeholder",
      "Mensagem para Cores",
    );
    await expect(page.getByTestId("pending-counter")).toHaveCount(0);
    // After a reload the card is still there, still answered (derived from the run and the messages).
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Cores"]').click();
    await expect(page.getByTestId("question-card")).toHaveAttribute("data-state", "answered");
    await expect(
      page
        .getByTestId("question-card")
        .locator('[data-testid="question-option"][aria-checked="true"]'),
    ).toHaveCount(1);
  });

  test("an open question survives a reload and can be answered afterwards, with the keyboard", async ({
    page,
  }) => {
    await openWithBot(page, world, "Teclado");
    await send(page, "CASE-OPTIONS escolha com o teclado");
    await expect(page.getByTestId("question-card")).toHaveAttribute("data-state", "open");
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Teclado"]').click();
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    // The letters choose: B is the second option.
    await card.getByTestId("question-option").first().focus();
    await page.keyboard.press("b");
    await expect(userBubbles(page).last()).toContainText("Verde");
    await expect(card).toHaveAttribute("data-state", "answered");
  });

  test("a questionnaire: skip one question, pick several in another, and the answer is one plain line per question", async ({
    page,
  }) => {
    await openWithBot(page, world, "Questionario");
    await send(page, "CASE-QUIZ pergunte");
    const card = page.getByTestId("question-card");
    await expect(card).toContainText("Qual banco de dados?");
    await expect(card.getByRole("img", { name: "Pergunta 1 de 3" })).toBeVisible();
    await card.getByRole("button", { name: "Pular" }).click();
    await expect(card).toContainText("Quais extras você quer?");
    await expect(card).toContainText("Selecione todas as opções aplicáveis");
    await card.getByTestId("question-option").filter({ hasText: "Cache" }).click();
    await card.getByTestId("question-option").filter({ hasText: "Fila" }).click();
    await expect(card.locator('[data-testid="question-option"][aria-checked="true"]')).toHaveCount(
      2,
    );
    await card.getByRole("button", { name: "Avançar" }).click();
    await expect(card).toContainText("Posso começar agora?");
    await expect(card.getByRole("button", { name: "Enviar" })).toBeVisible();
    // Back and forth keeps the choices.
    await card.getByRole("button", { name: "Voltar" }).click();
    await expect(card.locator('[data-testid="question-option"][aria-checked="true"]')).toHaveCount(
      2,
    );
    await card.getByRole("button", { name: "Avançar" }).click();
    await card.getByTestId("question-option").filter({ hasText: "Sim" }).click();
    await card.getByRole("button", { name: "Enviar" }).click();
    const reply =
      "1. Qual banco de dados? → (pulou)\n2. Quais extras você quer? → Cache; Fila\n3. Posso começar agora? → Sim";
    await expect(userBubbles(page).last()).toHaveText(reply);
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Anotei todas as respostas." }),
    ).toBeVisible();
    // The card is dimmed and shows what was chosen in each question.
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card.getByTestId("question-block")).toHaveCount(3);
    await expect(card.locator('[data-testid="question-option"][aria-checked="true"]')).toHaveCount(
      3,
    );
    // The model received exactly that text as the answer of its question.
    const bot = (await world.api.bots.list()).find((b) => b.name === "Questionario");
    const conversation = await world.api.bots.openConversation(bot?.id ?? "");
    const runs = await world.api.runs.list({ conversationId: conversation.id });
    const events = (await world.api.runs.events(runs.items[0]?.id ?? "", { limit: 1000 })).items;
    const call = events.find((e) => e.type === "tool_call" && e.payload.name === "escalate");
    expect(
      events.find((e) => e.type === "tool_result" && e.payload.callId === call?.payload.callId)
        ?.payload.content,
    ).toBe(reply);
  });

  test("answering by typing instead: the card becomes answered and dimmed, with nothing marked", async ({
    page,
  }) => {
    await openWithBot(page, world, "Digitando");
    await send(page, "CASE-QUIZ pergunte");
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    await send(page, "prefiro conversar sobre outra coisa");
    await expect(userBubbles(page).last()).toContainText("prefiro conversar sobre outra coisa");
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card.locator('[data-testid="question-option"][aria-checked="true"]')).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Anotei todas as respostas." }),
    ).toBeVisible();
  });

  test("a message sent while the bot works is 'sent' and then 'delivered' (dimmer, then normal)", async ({
    page,
  }) => {
    await openWithBot(page, world, "Ocupado");
    await send(page, "CASE-BUSY trabalhe um pouco");
    await expect(page.getByTestId("working-indicator")).toBeVisible();
    // The bot is in the middle of a step (its tool is running), so the next message waits its turn.
    await expect(page.getByTestId("action-card").first()).toBeVisible();
    await send(page, "e mais uma coisa");
    const second = userBubbles(page).last();
    await expect(second).toContainText("e mais uma coisa");
    await expect(second).toHaveAttribute("data-state", "sent");
    await expect(second).toHaveAttribute("data-state", "delivered");
    await expect(second).not.toContainText("lida pelo bot");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Li a sua segunda mensagem" }),
    ).toBeVisible();
  });

  test("pause and resume from the bot chip's context menu", async ({ page }) => {
    await openWithBot(page, world, "Pausa");
    await send(page, "CASE-LONG vá devagar");
    const chip = page.getByTestId("bot-chip");
    await expect(page.getByTestId("working-indicator")).toBeVisible();
    await chip.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pausar" }).click();
    await expect(page.getByTestId("working-indicator")).toHaveAttribute("data-phrase", "Pausado");
    await expect(page.locator('[data-testid="bot-item"][data-bot="Pausa"]')).toHaveAttribute(
      "data-chip",
      "paused",
    );
    await chip.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Continuar" }).click();
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Terminei os oito passos." }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  });

  test("the bot's text is rendered safely, and a failure is one line that opens what happened", async ({
    page,
  }) => {
    await openWithBot(page, world, "Texto");
    await send(page, "CASE-MD mostre");
    const bubble = page.getByTestId("message-bot").filter({ hasText: "Resumo:" });
    await expect(bubble).toBeVisible();
    await expect(bubble.locator("li")).toHaveCount(2);
    await expect(bubble.locator("strong")).toHaveText("item");
    await expect(bubble.locator("code").first()).toHaveText("código");
    await expect(bubble.locator("a")).toHaveAttribute("href", "https://example.com/docs");
    await expect(bubble.locator("script")).toHaveCount(0);
    await expect(bubble).toContainText("<script>alert(1)</script>");

    await send(page, "CASE-FAIL quebre");
    const ended = page.getByTestId("ended-line");
    await expect(ended).toHaveText("Não consegui terminar: o provedor do modelo falhou");
    await expect(page.locator('[data-testid="bot-item"][data-bot="Texto"]')).toHaveAttribute(
      "data-chip",
      "failed",
    );
    // It expands IN PLACE (no dialog): the origin and what it means, and the way to the inspector.
    await expect(ended).toHaveAttribute("aria-expanded", "false");
    // It expands IN PLACE (no dialog): the origin and what it means, and the way to the inspector.
    await expect(ended).toHaveAttribute("aria-expanded", "false");
    await ended.click();
    await expect(ended).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const origin = page.getByTestId("ended-origin");
    await expect(origin).toHaveAttribute("data-origin", "provider");
    await expect(origin).toHaveText(
      "O modelo não respondeu agora (rede, chave ou limite de uso). Tenta de novo daqui a pouco?",
    );
    await expect(
      page.getByTestId("ended-detail").getByRole("button", { name: "Abrir no inspetor" }),
    ).toBeVisible();
    await ended.click();
    await expect(page.getByTestId("ended-detail")).toHaveCount(0);
  });

  test("scrolled up, a round button takes you to the end", async ({ page }) => {
    await openWithBot(page, world, "Alto");
    await send(page, "CASE-TALL escreva muito");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Linha 90 da resposta longa." }),
    ).toBeVisible();
    const scroll = page.getByTestId("message-scroll");
    await expect(page.getByTestId("jump-to-end")).toHaveCount(0);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    const jump = page.getByTestId("jump-to-end");
    await expect(jump).toBeVisible();
    await jump.click();
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(40);
    await expect(jump).toHaveCount(0);
  });
});
