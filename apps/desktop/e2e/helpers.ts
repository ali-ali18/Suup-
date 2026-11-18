import { expect, type Locator, type Page } from "@playwright/test";
import type { World } from "./harness.js";

/** Opens the app and connects with the world's token (the connection is kept in the tab). */
export async function connect(
  page: Page,
  world: World,
  token: string = world.token,
): Promise<void> {
  await page.goto(world.appUrl);
  await page.getByLabel("Endereço do servidor").fill(world.serverUrl);
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Conectar" }).click();
}

export async function openApp(page: Page, world: World): Promise<void> {
  await connect(page, world);
  await expect(page.getByTestId("sidebar")).toBeVisible();
}

export const botItem = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="bot-item"][data-bot="${name}"]`);

export async function selectBot(page: Page, name: string): Promise<void> {
  await botItem(page, name).click();
  await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", name);
}

export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Mensagem", { exact: true });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
}

export const userBubbles = (page: Page): Locator => page.getByTestId("message-user");

/** Waits for the run of this chat to end (the work block is gone and the composer is free). */
export async function expectIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("work-block")).toHaveCount(0);
}

/**
 * A bot of its own for a test. The scripted provider picks its script by looking at the whole
 * conversation, so tests that share a conversation would answer each other's cases.
 */
export async function freshBot(
  world: World,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await world.api.bots.create({
    name,
    description: "Bot de teste.",
    personality: "Seja objetivo.",
    modelId: "model-x",
    allowedTools: ["shell", "read_file", "write_file", "edit_file"],
    ...extra,
  });
}

/** A fresh bot, the app opened and the bot selected. */
export async function openWithBot(page: Page, world: World, name: string): Promise<void> {
  await freshBot(world, name);
  await openApp(page, world);
  await selectBot(page, name);
}
