import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { freshBot, openApp, selectBot, send } from "./helpers.js";

// The bot's live avatar in the chat (docs/DESIGN.md §3, "O bot trabalhando"): while a scripted run
// thinks, then runs a command, then answers, the last thing in the chat is the bot's own face
// (its style, 3D and colour) with a short friendly phrase; it replaced the three dots, its
// expression follows the run, and it leaves when the answer arrives. No tool row appears at all
// (the chat shows results only). Screenshots at 1440x900@2x for both styles.

const SHOTS = fileURLToPath(new URL("../screenshots/avatar-vivo/1440x900@2x/", import.meta.url));

const STYLES = [
  { name: "Vivo Formas", label: "formas", extra: { avatar: "mascot:blob", color: "azul" } },
  {
    name: "Vivo Pixel",
    label: "pixel",
    extra: { avatarStyle: "pixel", avatar: "mascot:gato", color: null },
  },
  {
    name: "Vivo Pixel 3D",
    label: "pixel-3d",
    extra: { avatarStyle: "pixel", avatar: "mascot:nuvem", avatarPixel3d: true, color: "verde" },
  },
] as const;

const indicator = (page: Page) => page.getByTestId("working-indicator");
const face = (page: Page) => indicator(page).locator("[data-mascot]");

test.describe("the live avatar in the chat", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
    await mkdir(SHOTS, { recursive: true });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  for (const style of STYLES) {
    test(`${style.label}: thinking, then a command, then done; the avatar shows and leaves`, async ({
      page,
    }) => {
      await freshBot(world, style.name, style.extra);
      await openApp(page, world);
      await selectBot(page, style.name);
      await send(page, "CASE-LIVE confira o arquivo");

      // Thinking: the bot's face with the "pondering" expression, a calm status, no dots.
      await expect(indicator(page)).toHaveAttribute("data-activity", "thinking");
      await expect(indicator(page)).toHaveAttribute("role", "status");
      await expect(indicator(page)).toContainText("Pensando…");
      await expect(face(page)).toHaveAttribute("data-state", "pondering");
      await expect(face(page)).toHaveAttribute("data-mode", "animated");
      await expect(page.getByTestId("dots-dot")).toHaveCount(0);
      if ("avatarStyle" in style.extra) {
        await expect(face(page)).toHaveAttribute("data-mascot-style", "pixel");
        if ("avatarPixel3d" in style.extra)
          await expect(face(page)).toHaveAttribute("data-pixel3d", "true");
      } else {
        await expect(face(page)).toHaveAttribute("data-mascot", "blob");
        await expect(face(page)).toHaveAttribute("data-color", "azul");
      }
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${SHOTS}${style.label}-1-pensando.png` });

      // A command: the focused "coding" face and a friendly phrase (never the command itself).
      await expect(indicator(page)).toHaveAttribute("data-activity", "terminal");
      await expect(face(page)).toHaveAttribute("data-state", "coding");
      await expect(indicator(page)).toContainText("Rodando um comando…");
      await expect(indicator(page)).not.toContainText("sleep");
      // The chat shows results only: the command is no row.
      await expect(page.getByTestId("action-card")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}${style.label}-2-rodando-um-comando.png` });

      // Done: the answer arrives and the avatar leaves (no row of what it did stays behind).
      await expect(
        page.getByTestId("message-bot").filter({ hasText: "Pronto: conferi tudo e está certo." }),
      ).toBeVisible();
      await expect(indicator(page)).toHaveCount(0);
      await expect(page.getByTestId("working-wrap")).toHaveCount(0);
      await expect(page.getByTestId("action-card")).toHaveCount(0);
      await expect(page.getByTestId("action-fold")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}${style.label}-3-respondeu.png` });
    });
  }

  test("reduced motion: the face is still, and the avatar still shows and leaves", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await freshBot(world, "Vivo Calmo", { avatar: "mascot:blob", color: "rosa" });
    await openApp(page, world);
    await selectBot(page, "Vivo Calmo");
    await send(page, "CASE-LIVE confira o arquivo");
    await expect(indicator(page)).toHaveAttribute("data-activity", "thinking");
    await expect(face(page)).toHaveAttribute("data-mode", "still");
    await expect(face(page)).toHaveAttribute("data-state", "pondering");
    await expect(indicator(page)).toHaveAttribute("data-activity", "terminal");
    await expect(face(page)).toHaveAttribute("data-state", "coding");
    await expect(face(page)).toHaveAttribute("data-mode", "still");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Pronto: conferi tudo e está certo." }),
    ).toBeVisible();
    await expect(indicator(page)).toHaveCount(0);
  });
});
