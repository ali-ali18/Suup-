import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send, userBubbles } from "./helpers.js";

test.describe("the app converges", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("a reload in the middle of a run ends in the same state", async ({ page }) => {
    await openWithBot(page, world, "Recarga");
    await send(page, "CASE-LONG recarregue no meio");
    await expect(page.getByTestId("action-card").first()).toBeVisible();
    await page.reload();
    // The page starts again on the main bot; the conversation is the server's, not the page's.
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.locator('[data-testid="bot-item"][data-bot="Recarga"]').click();
    await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Recarga");
    await expect(userBubbles(page)).toHaveCount(1);
    await expect(
      page.getByTestId("working-indicator").or(page.getByTestId("message-bot")).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Terminei os oito passos." }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
    // Eight finished cards: the latest three, and the five older ones folded into one row.
    await expect(page.getByTestId("action-fold")).toContainText("Mais 5 ações");
    await expect(page.getByTestId("action-card")).toHaveCount(3);
    // The server agrees: one run, done, eight tool calls.
    const bot = (await world.api.bots.list()).find((b) => b.name === "Recarga");
    expect(bot?.latestRun?.status).toBe("done");
    // O app marca como lido depois que a contagem chega pelo fluxo: é assíncrono, então espera convergir.
    await expect
      .poll(
        async () => (await world.api.bots.list()).find((b) => b.name === "Recarga")?.unreadCount,
      )
      .toBe(0);
  });

  test("the server is killed and restarted mid-run: the app reconnects and converges", async ({
    page,
  }) => {
    await openWithBot(page, world, "Reinicio");
    await send(page, "CASE-LONG reinicie o servidor");
    await expect(page.getByTestId("action-card").first()).toBeVisible();
    await world.stopServer();
    // While it is down the app says so, and keeps what it had.
    await expect(page.getByTestId("connection-banner")).toContainText("Reconectando");
    await expect(page.getByTestId("action-card").first()).toBeVisible();
    // The worker is another process: the run goes on without the server.
    await world.startServer();
    await expect(page.getByTestId("connection-banner")).toHaveCount(0);
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Terminei os oito passos." }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
    await expect(page.getByTestId("action-fold")).toContainText("Mais 5 ações");
    await expect(userBubbles(page)).toHaveCount(1);
    // Sending still works afterwards.
    await send(page, "OI-SIMPLES depois do reinício");
    await expect(userBubbles(page)).toHaveCount(2);
    await expect(page.getByTestId("message-bot")).toHaveCount(2, { timeout: 60_000 });
  });
});
