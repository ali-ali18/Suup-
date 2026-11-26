import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// KOD-64: what the bot writes in a turn that also calls tools is a bubble of its own, in the order
// it happened: bubble, card, bubble. Live and after a reload, with no bubble drawn twice. Pictures at
// 1440x900@2x go to screenshots/1440x900@2x/ (outside git).

/** What the chat draws, top to bottom: the text of each bot bubble, and the name of each card. */
async function sequence(page: Page): Promise<string[]> {
  return page
    .getByTestId("chat-log")
    .locator(
      '[data-testid="bubble-bot"], [data-testid="question-card"], [data-testid="secret-form"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getAttribute("data-testid");
        return id === "bubble-bot" ? `bubble:${(node.textContent ?? "").trim()}` : (id ?? "?");
      }),
    );
}

test.describe("the words of a turn are bubbles, in the order of the log", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.afterEach(async () => {
    await world.stop();
  });

  test("text, question card, text: in order, then the same after a reload, nothing twice", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    world = await startWorld();
    await openWithBot(page, world, "Agenda");
    await send(page, "CASE-PARTS marque uma reunião");

    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 60_000 });
    // The words are revealed progressively, so wait for the last bubble to be complete.
    await expect
      .poll(() => sequence(page), { timeout: 15_000 })
      .toEqual([
        "bubble:Vou conferir a agenda.",
        "bubble:Achei dois horários livres.",
        "question-card",
      ]);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/partes-texto-cartao.png" });

    await card.getByTestId("question-option").filter({ hasText: "Às quinze" }).click();
    await expect(
      page.getByTestId("bubble-bot").filter({ hasText: "Pronto, reservei." }),
    ).toBeVisible({ timeout: 60_000 });
    const expected = [
      "bubble:Vou conferir a agenda.",
      "bubble:Achei dois horários livres.",
      "question-card",
      "bubble:Vou reservar o horário que você escolheu.",
      "bubble:Pronto, reservei.",
    ];
    await expect.poll(() => sequence(page), { timeout: 15_000 }).toEqual(expected);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/partes-texto-cartao-texto.png" });

    // The same after a reload: each part once, in the same order.
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Agenda"]').click();
    await expect(
      page.getByTestId("bubble-bot").filter({ hasText: "Pronto, reservei." }),
    ).toBeVisible();
    expect(await sequence(page)).toEqual(expected);
    // The server holds each part once, keyed by run, event and block: the same words, once.
    const conversation = (await world.api.bots.list()).find((b) => b.name === "Agenda")
      ?.conversationId as string;
    const bots = (await world.api.conversations.messages(conversation)).items.filter(
      (m) => m.authorKind === "bot",
    );
    expect(bots.map((m) => m.text)).toEqual([
      "Vou conferir a agenda.",
      "Achei dois horários livres.",
      "Qual horário você prefere?",
      "Vou reservar o horário que você escolheu.",
      "Pronto, reservei.",
    ]);
    expect(bots.map((m) => m.eventSeq !== undefined)).toEqual([true, true, false, true, false]);
  });

  test("text, then the secure form: the words are above it, with no text of the system", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    world = await startWorld();
    await openWithBot(page, world, "Chaveiro");
    await send(page, "CASE-PARTS-SECRET guarde a chave");

    const form = page.getByTestId("secret-form");
    await expect(form).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => sequence(page), { timeout: 15_000 })
      .toEqual(["bubble:Antes de seguir, preciso de uma chave.", "secret-form"]);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/partes-texto-segredo.png" });

    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Chaveiro"]').click();
    await expect(page.getByTestId("secret-form")).toBeVisible();
    expect(await sequence(page)).toEqual([
      "bubble:Antes de seguir, preciso de uma chave.",
      "secret-form",
    ]);
  });
});
