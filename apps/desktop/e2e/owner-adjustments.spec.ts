import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, freshBot } from "./helpers.js";
import { installTauriMock } from "./tauri-mock.js";

// The owner's interface items of 23-24/11/2026 (docs/DESIGN.md §1 "Nada seco", §2 max width, §4a,
// §4c, §5, §6), in the app shell with its own window buttons (as on Windows), and the screenshots
// to compare with the owner's: 1440x900 at 2x and a wide 2560x1440 (a 32" monitor).

const SIZES = [
  { dir: "1440x900@2x", viewport: { width: 1440, height: 900 }, scale: 2 },
  { dir: "2560x1440", viewport: { width: 2560, height: 1440 }, scale: 1 },
] as const;

async function openFramed(page: Page, world: World): Promise<void> {
  await installTauriMock(page, world, { vps: true, frame: "custom" });
  await page.goto(world.appUrl);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("window-controls")).toBeVisible();
}

test.describe("owner adjustments", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
    await freshBot(world, "Estudo de Leitura", { color: "azul", avatar: "mascot:blob" });
    await freshBot(world, "Dev de Exemplo", { color: "amarelo", avatar: "mascot:cloud" });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  for (const size of SIZES) {
    test(`the screens at ${size.dir}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: size.scale,
        locale: "pt-BR",
      });
      const page = await context.newPage();
      const shot = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `screenshots/${size.dir}/${name}.png` });
      };
      await openFramed(page, world);

      // No bot is marked until the owner picks one (the chat opens on the main bot anyway).
      await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Principal");
      await expect(page.getByTestId("sidebar").locator('[aria-current="page"]')).toHaveCount(0);
      // The main bot's star: the owner's orange marker, the face notched around it.
      await expect(
        page.getByTestId("sidebar").getByTestId("supervisor-star").first(),
      ).toBeVisible();
      await expect(page.getByTestId("sidebar").getByText("Sem interação").first()).toBeVisible();
      // The pill floats over the chat on a fade; the panel's close sits left of the window buttons.
      await expect(page.getByTestId("chat-head")).toBeVisible();
      const close = await page.getByTestId("panel-close").boundingBox();
      const controls = await page.getByTestId("window-controls").boundingBox();
      if (close !== null && controls !== null) {
        expect(close.x + close.width).toBeLessThanOrEqual(controls.x);
        // on the strip of the window buttons: their centres on one line
        expect(
          Math.abs(close.y + close.height / 2 - (controls.y + controls.height / 2)),
        ).toBeLessThan(3);
      }
      await shot("30-chat-sem-bot-marcado");

      // The owner menu: icons, one action at the bottom.
      await page.getByTestId("owner-menu").click();
      await expect(page.getByRole("menu").getByTestId("menu-icon")).toHaveCount(6);
      await shot("31-menu-da-conta");
      await page.keyboard.press("Escape");

      // The panel's chat model (base-maia, 24/11/2026): the list opens under its button, with room.
      await page.getByTestId("chat-model").click();
      await expect(page.getByRole("listbox", { name: "Modelo de chat" })).toBeVisible();
      await shot("38-modelo-de-chat-aberto");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page.getByTestId("chat-model")).toBeFocused();

      // A round icon button shows its name as the app's tip (not the native title).
      await page.getByRole("button", { name: "Novo bot" }).first().hover();
      await expect(page.getByText("Novo bot", { exact: true })).toBeVisible();
      await shot("39-dica-do-botao");
      await page.mouse.move(size.viewport.width / 2, size.viewport.height / 2);

      // The rail: hovering a bot shows only its name.
      await page.keyboard.press("Control+b");
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
      await botItem(page, "Estudo de Leitura").hover();
      await expect(page.getByTestId("rail-tip")).toHaveText("Estudo de Leitura");
      await shot("32-trilho-so-o-nome");
      await page.mouse.move(size.viewport.width / 2, size.viewport.height / 2);
      await page.keyboard.press("Control+b");
      await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");

      // Picking a bot marks it.
      await botItem(page, "Estudo de Leitura").click();
      await expect(page.getByTestId("sidebar").locator('[aria-current="page"]')).toHaveCount(1);

      // The new bot dialog: white by default, the 3D pixel mascot as big as the shapes.
      await page.getByRole("button", { name: "Novo bot" }).first().click();
      await expect(page.getByTestId("newbot-preview")).toHaveAttribute("data-color", "branco");
      await shot("34-criar-bot");
      await page.getByTestId("newbot-style-pixel").click();
      await page.getByTestId("newbot-pixel3d").click();
      await shot("35-criar-bot-pixel-3d");
      await page.keyboard.press("Escape");

      // Connectors: centred in a column of max width; the head keeps the window buttons' corner.
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: "Conectores" }).click();
      await expect(page.getByTestId("connectors-screen")).toBeVisible();
      const body = await page.getByTestId("screen-body").boundingBox();
      expect(body?.width ?? 0).toBeLessThanOrEqual(1120 + 1);
      const custom = await page.getByTestId("connectors-add-custom").boundingBox();
      const strip = await page.getByTestId("window-controls").boundingBox();
      if (custom !== null && strip !== null)
        expect(custom.x + custom.width).toBeLessThanOrEqual(strip.x);
      await shot("36-conectores");
      await page.getByTestId("connector-item").first().click();
      await expect(page.getByTestId("connector-page")).toBeVisible();
      await shot("37-pagina-do-conector");
      await context.close();
    });
  }

  test("the three avatar styles side by side: shapes, pixel 2D and pixel 3D (and the star on a pixel Principal)", async ({
    browser,
  }) => {
    const { api } = world;
    const principal = (await api.bots.list()).find((b) => b.isDefault);
    if (principal !== undefined)
      await api.bots.update(principal.id, {
        avatarStyle: "pixel",
        avatar: "mascot:gato",
        avatarPixel3d: false,
        color: null,
      });
    await freshBot(world, "Formas", { avatar: "mascot:blob", color: "laranja" });
    await freshBot(world, "Pixel 2D", { avatarStyle: "pixel", avatar: "mascot:folha" });
    await freshBot(world, "Pixel 3D", {
      avatarStyle: "pixel",
      avatar: "mascot:robo",
      avatarPixel3d: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: "pt-BR",
    });
    const page = await context.newPage();
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `screenshots/1440x900@2x/${name}.png` });
    };
    await openFramed(page, world);
    for (const name of ["Formas", "Pixel 2D", "Pixel 3D"])
      await expect(botItem(page, name)).toBeVisible();
    await expect(botItem(page, "Pixel 3D").locator('[data-pixel3d="true"]')).toBeAttached();
    await expect(botItem(page, "Principal").locator('[data-mascot-style="pixel"]')).toBeAttached();
    await expect(botItem(page, "Principal").getByTestId("supervisor-star")).toBeVisible();
    await botItem(page, "Pixel 3D").click();
    await page.mouse.move(720, 450);
    await shot("38-estilos-de-avatar-barra");
    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    await shot("39-estilos-de-avatar-trilho");
    await context.close();
  });
});
