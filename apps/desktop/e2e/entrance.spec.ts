import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, passWelcome } from "./helpers.js";

// The entrance of a new device on a server with no bot: the welcome (the name), the address, the
// token, the connectors (once), "Crie seu bot", and then the app with the bot just made.

test.describe("the entrance, on a server with no bots", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("welcome, address, token, connectors, first bot, and the app; the name reached the server", async ({
    page,
  }) => {
    expect(await world.api.bots.list()).toHaveLength(0);
    await page.goto(world.appUrl);
    await passWelcome(page, "Marina");

    await page.getByLabel("Endereço do servidor").fill(world.serverUrl);
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Token").fill(world.token);
    await page.getByRole("button", { name: "Conectar" }).click();

    // No bot yet: the connectors come first (once on this device), then the first bot.
    await page.getByTestId("connectors-continue").click();
    await expect(page.getByTestId("create-bot")).toBeVisible();
    await page.getByTestId("create-next").click();
    await page.getByPlaceholder("Dê um nome ao seu bot").fill("Primeiro Bot");
    await page.getByTestId("create-next").click();
    await page.getByTestId("first-bot-create").click();

    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(botItem(page, "Primeiro Bot")).toBeVisible();
    expect((await world.api.bots.list()).map((b) => b.name)).toEqual(["Primeiro Bot"]);
    await expect.poll(async () => (await world.api.userSettings.get()).ownerName).toBe("Marina");
  });
});
