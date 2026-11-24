import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// The owner's items of 24/11/2026, in a real run of the app: the bot makes a document and hands it
// over (the file card under its message, downloaded by the browser), the terminal rows of the run
// are collapsed lines, and a question with options is the bubble and, apart, the card. Screenshots
// at 1440x900@2x go to screenshots/1440x900@2x/ (outside git).

test.describe("files in the chat, collapsed rows, the question apart", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.afterEach(async () => {
    await world.stop();
  });

  test("the bot makes a file and sends it: a card under its answer that downloads the file", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    world = await startWorld();
    await openWithBot(page, world, "Pesquisa");
    await send(page, "CASE-FILE faça um PDF com a história da PUCPR");

    const answer = page
      .getByTestId("message-bot")
      .filter({ hasText: "Pronto: o PDF com a história da PUCPR está aqui embaixo." });
    await expect(answer).toBeVisible({ timeout: 60_000 });

    // The card, right under the answer: icon by kind, the name, what it is and its size.
    const card = page.getByTestId("file-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-kind", "pdf");
    await expect(card.getByTestId("file-name")).toHaveText("historia_pucpr.pdf");
    await expect(card.getByTestId("file-meta")).toHaveText("PDF · 35 bytes");
    const aBox = await answer.boundingBox();
    const cBox = await card.boundingBox();
    expect(cBox?.y ?? 0).toBeGreaterThan((aBox?.y ?? 0) + (aBox?.height ?? 0) - 1);
    // Nothing technical: no path of the bot's machine, no MIME type.
    await expect(page.getByTestId("chat-log")).not.toContainText("/workspace");
    await expect(card).not.toContainText("application/pdf");

    // The file appears ONCE: the card. The call that handed it over is no row (nor in a fold).
    await expect(page.getByTestId("chat-log").getByText("historia_pucpr.pdf")).toHaveCount(1);
    await expect(page.getByTestId("action-card")).toHaveCount(2);
    await expect(page.getByTestId("chat-log")).not.toContainText("Entregar");
    // The terminal rows of the run are ONE collapsed line each: no command, no output in view.
    const rows = page.getByTestId("action-card");
    await expect(rows.first()).toHaveAttribute("data-state", "done");
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute("data-expanded", "false");
    }
    await expect(page.getByTestId("action-output")).toHaveCount(0);
    await expect(page.getByTestId("chat-log")).not.toContainText("linha 7 do relatório");

    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/arquivo-no-chat.png" });

    // The browser has no other program to open it with: only "Baixar", which downloads it.
    await expect(card.getByRole("button", { name: "Abrir" })).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      card.getByRole("button", { name: "Baixar" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("historia_pucpr.pdf");
    const path = await download.path();
    expect(await readFile(path, "utf8")).toBe("%PDF-1.4\n% Historia da PUCPR\n%%EOF\n");

    // A click opens a row in place (the command and its output); the others stay closed.
    await rows.nth(1).getByRole("button").click();
    await expect(rows.nth(1)).toHaveAttribute("data-expanded", "true");
    await expect(page.getByTestId("action-output")).toContainText("linha 7 do relatório");
    await expect(rows.nth(0)).toHaveAttribute("data-expanded", "false");
  });

  test("a question: the bot's words in the bubble, the question as the card's title, the hint; the X locks it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    world = await startWorld();
    await openWithBot(page, world, "Cores");
    await send(page, "CASE-ASKCTX faça o PDF da PUCPR");
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    // The bubble: the bot's context, which does not repeat the question.
    const bubble = page
      .getByTestId("message-bot")
      .filter({ hasText: "A busca na web está fora do ar" })
      .locator('[data-testid="bubble-bot"]');
    await expect(bubble).toBeVisible();
    await expect(bubble).not.toContainText("Como você prefere seguir?");
    // The card: the question as its visible title, options by title, the X; the hint outside it.
    await expect(card.getByTestId("question-text")).toBeVisible();
    await expect(card.getByTestId("question-text")).toHaveText("Como você prefere seguir?");
    await expect(page.getByTestId("chat-log").getByText("Como você prefere seguir?")).toHaveCount(
      1,
    );
    await expect(card.getByTestId("question-option")).toHaveText([
      "AEsperar e tentar de novo",
      "BMandar um link da PUCPR",
      "CPDF sem fontes",
    ]);
    const hint = page.getByTestId("question-hint");
    await expect(hint).toHaveText("Ou responda no chat abaixo");
    await expect(card.getByTestId("question-hint")).toHaveCount(0);
    expect(await hint.evaluate((el) => el.tagName)).toBe("P");
    // No ring on an option at load: the card holds the focus.
    await expect(card).toBeFocused();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/pergunta-separada.png" });

    // The X: the card STAYS, locked ("Não respondido"), its title visible, the options off, and the
    // composer takes the focus. The run is told and goes on by itself.
    await card.getByRole("button", { name: "Fechar e responder no chat" }).click();
    const composer = page.getByLabel("Mensagem", { exact: true });
    await expect(composer).toBeFocused();
    await expect(card).toHaveAttribute("data-state", "dismissed");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("question-text")).toBeVisible();
    await expect(card.getByTestId("question-text")).toHaveText("Como você prefere seguir?");
    await expect(card.getByTestId("question-status")).toHaveText("Não respondido");
    for (const option of await card.getByTestId("question-option").all()) {
      await expect(option).toBeDisabled();
      await expect(option).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.getByTestId("question-hint")).toHaveCount(0);
    await expect(page.getByTestId("message-bot").filter({ hasText: "Combinado." })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: "screenshots/1440x900@2x/pergunta-nao-respondida.png" });
    // In the history (after a reload) the card is the same: locked, "Não respondido".
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Cores"]').click();
    await expect(page.getByTestId("question-card")).toHaveAttribute("data-state", "dismissed");
    await expect(page.getByTestId("question-status")).toHaveText("Não respondido");
    await expect(page.getByTestId("question-text")).toHaveText("Como você prefere seguir?");
  });
});
