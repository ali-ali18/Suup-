import { expect, type Locator, type Page } from "@playwright/test";
import type { World } from "./harness.js";

/**
 * Opens the app and connects with the world's token (the connection is kept in the tab), going
 * through the entrance's steps: the address, then the token. By default the welcome and the
 * connectors step count as already seen on this device (`entrance: true` leaves them to show).
 */
export async function connect(
  page: Page,
  world: World,
  token: string = world.token,
  options: { entrance?: boolean } = {},
): Promise<void> {
  if (options.entrance !== true) await markEntranceSeen(page);
  await page.goto(world.appUrl);
  await page.getByLabel("Endereço do servidor").fill(world.serverUrl);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Conectar" }).click();
}

/** This device has already seen the welcome and the connectors step (the entrance skips them). */
export async function markEntranceSeen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("suup.welcomeDone", "1");
    localStorage.setItem("suup.connectorsStepDone", "1");
  });
}

/** The welcome of a new device: the name (required), then "Continuar"; resolves when the form is gone. */
export async function passWelcome(page: Page, name = "Marina"): Promise<void> {
  const form = page.getByTestId("welcome-form");
  await form.getByPlaceholder("Seu nome").fill(name);
  await form.getByRole("button", { name: "Continuar" }).click();
  await expect(form).toHaveCount(0);
}

/** The server's supervisor: a bot of this name, marked as the principal one. */
export async function principalBot(world: World, name = "Principal"): Promise<void> {
  // Every tool the server has, as the first bot of the entrance gets them.
  const tools = (await world.api.tools.list()).items.map((tool) => tool.name);
  const bot = await world.api.bots.create({
    name,
    description: "Assistente da equipe.",
    personality: "Seja objetivo.",
    modelId: "model-x",
    allowedTools: tools,
  });
  await world.api.bots.setDefault(bot.id);
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
    allowedTools: ["shell", "read_file", "write_file", "edit_file", "web_fetch"],
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

/** Closes the settings dialog with Escape; the focus goes back to where it was. */
export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-screen")).toHaveCount(0);
}

/**
 * Opens the page of an installed plugin, as a person does: Configurações > Conectores (the
 * "Instalado" list), then its row. Everything about a connector (switch, test, bots, tools, risks,
 * removing) is on that page, in the Conectores screen; Settings closes.
 */
export async function openPluginPage(page: Page, plugin: string): Promise<Locator> {
  await openSettings(page, "Conectores");
  const row = page.locator(`[data-testid="installed-item"][data-plugin="${plugin}"]`);
  await expect(row).toBeVisible();
  await row.locator("button").first().click();
  await expect(page.getByTestId("settings-screen")).toHaveCount(0);
  const connector = page.getByTestId("connector-page");
  await expect(connector).toBeVisible();
  return connector;
}

/** Chooses an option of one of the app's dropdowns (never a native select): open it, click the option. */
export async function choose(page: Page, dropdown: Locator, label: string): Promise<void> {
  await dropdown.click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
