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

export type SettingsSection = "Geral" | "Permissões" | "Memória" | "Busca" | "Cofre" | "Conectores";

/** Opens the settings dialog on a section (from the owner menu, as a person would). */
export async function openSettings(page: Page, section: SettingsSection): Promise<void> {
  await page.getByTestId("owner-menu").click();
  await page.getByRole("menuitem", { name: "Configurações" }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("tab", { name: section }).click();
  await expect(page.getByRole("tab", { name: section })).toHaveAttribute("aria-selected", "true");
}

/** Closes the settings dialog with Escape (twice from a connector's details); the focus goes back to where it was. */
export async function closeSettings(page: Page): Promise<void> {
  // Inside a connector's details the first Escape only goes back to the list; the second closes.
  const inDetails = (await page.getByTestId("connector-panel").count()) > 0;
  await page.keyboard.press("Escape");
  if (inDetails) {
    await expect(page.getByTestId("connector-panel")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  await expect(page.getByTestId("settings-screen")).toHaveCount(0);
}

/** Chooses an option of one of the app's dropdowns (never a native select): open it, click the option. */
export async function choose(page: Page, dropdown: Locator, label: string): Promise<void> {
  await dropdown.click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
