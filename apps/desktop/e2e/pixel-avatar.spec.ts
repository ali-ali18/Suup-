import { expect, type Locator, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, freshBot, openApp, selectBot } from "./helpers.js";

// O segundo estilo de avatar: os mascotes pixelados do dono. Cria um bot pixel pelo app, vê na barra
// lateral, confere que o desenho sai em pixels inteiros e tira capturas (barra e seletor) para
// comparar com o Figma.

const SIZES = [
  { dir: "1920x1080", viewport: { width: 1920, height: 1080 }, scale: 1 },
  { dir: "1440x900@2x", viewport: { width: 1440, height: 900 }, scale: 2 },
] as const;

/** Lê os pixels do canvas do mascote: o que foi pintado, em quantos pixels de dispositivo por célula. */
async function readCanvas(canvas: Locator) {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    const colors = new Map<string, number>();
    let painted = 0;
    let minX = width;
    let maxX = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] === 0) continue;
        painted++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        const hex = [data[i], data[i + 1], data[i + 2]]
          .map((v) => (v as number).toString(16).padStart(2, "0"))
          .join("");
        colors.set(hex, (colors.get(hex) ?? 0) + 1);
      }
    return {
      width,
      height,
      cssWidth: c.getBoundingClientRect().width,
      ratio: window.devicePixelRatio,
      painted,
      minX,
      maxX,
      colors: Object.fromEntries(colors),
    };
  });
}

const pixelOf = (scope: Locator | Page, name: string): Locator =>
  scope.locator(`[data-testid="bot-item"][data-bot="${name}"] [data-mascot-style="pixel"]`);

test.describe("avatar pixel", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("create a pixel bot in the app, see it in the sidebar in whole pixels, and edit its style", async ({
    page,
  }) => {
    // Old bots (no style) stay on the shapes.
    await freshBot(world, "Velhinho", { avatar: "mascot:blob", color: "azul" });
    await openApp(page, world);
    await page.getByRole("button", { name: "Novo bot" }).click();
    const dialog = page.getByRole("dialog", { name: "Criar novo Bot" });
    await expect(dialog.getByTestId("newbot-mascots")).toHaveAttribute("data-style", "shapes");
    await expect(dialog.getByRole("radio", { name: "Formas" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await dialog.getByRole("radio", { name: "Pixel" }).click();
    await expect(dialog.getByTestId("newbot-mascots")).toHaveAttribute("data-style", "pixel");
    // 17 characters, each with a live canvas.
    await expect(dialog.getByTestId("newbot-mascots").getByRole("radio")).toHaveCount(17);
    await dialog.getByLabel("Dê um nome ao seu bot").fill("Gatinho");
    await dialog.getByRole("radio", { name: "Gato" }).click();
    const preview = dialog.getByTestId("newbot-preview").locator("[data-mascot-style=pixel]");
    await expect(preview).toHaveAttribute("data-mascot", "gato");
    await expect(preview).toHaveAttribute("data-color", "original");
    await dialog.getByRole("button", { name: "Criar", exact: true }).click();
    await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Gatinho");

    // Stored with the bot: the style, the character, and no colour (the drawing's own).
    const created = (await world.api.bots.list()).find((b) => b.name === "Gatinho");
    expect(created).toMatchObject({ avatar: "mascot:gato", avatarStyle: "pixel", color: null });
    const old = (await world.api.bots.list()).find((b) => b.name === "Velhinho");
    expect(old?.avatarStyle).toBe("shapes");

    // The sidebar draws the pixel mascot; the old bot still draws the shapes.
    const mascot = pixelOf(page, "Gatinho");
    await expect(mascot).toHaveAttribute("data-mascot", "gato");
    await expect(pixelOf(page, "Velhinho")).toHaveCount(0);
    await expect(botItem(page, "Velhinho").locator("svg").first()).toBeVisible();
    const read = await readCanvas(mascot.locator("canvas"));
    // The canvas is exactly the size of the screen in device pixels (no rescale).
    expect(read.width).toBe(Math.round(read.cssWidth * read.ratio));
    expect(read.painted).toBeGreaterThan(100);
    // The cat's body is the colour of the drawing (#0ea5c6) and the eyes are white.
    const body = read.colors["0ea5c6"] ?? 0;
    expect(body).toBeGreaterThan(read.painted / 2);
    expect(Object.keys(read.colors).every((c) => ["0ea5c6", "ffffff", "1b1f3b"].includes(c))).toBe(
      true,
    );
    // Whole pixels: no semi-transparent edge, every painted pixel is a pure colour.
    const alpha = await mascot.locator("canvas").evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(
        0,
        0,
        c.width,
        c.height,
      ).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0 && d[i] !== 255) return false;
      return true;
    });
    expect(alpha).toBe(true);

    // Edit: the style and the character come back, and the colour can tint the body.
    await page.getByTestId("bot-chip").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
    const edit = page.getByRole("dialog", { name: /Editar bot/ });
    await expect(edit.getByRole("radio", { name: "Pixel" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(edit.getByRole("radio", { name: "Gato" })).toHaveAttribute("aria-checked", "true");
    await expect(edit.getByRole("radio", { name: "Original" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await edit.getByRole("radio", { name: "Rosa" }).click();
    await edit.getByRole("radio", { name: "Coruja" }).click();
    await edit.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(async () => (await world.api.bots.list()).find((b) => b.name === "Gatinho"))
      .toMatchObject({ avatar: "mascot:coruja", avatarStyle: "pixel", color: "rosa" });
    await expect(pixelOf(page, "Gatinho")).toHaveAttribute("data-mascot", "coruja");
    const tinted = await readCanvas(pixelOf(page, "Gatinho").locator("canvas"));
    expect(tinted.colors.ff5c8a ?? 0).toBeGreaterThan(tinted.painted / 2);

    // And back to the shapes.
    await page.getByTestId("bot-chip").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
    const back = page.getByRole("dialog", { name: /Editar bot/ });
    await back.getByRole("radio", { name: "Formas" }).click();
    await back.getByRole("button", { name: "Salvar" }).click();
    await expect
      .poll(
        async () => (await world.api.bots.list()).find((b) => b.name === "Gatinho")?.avatarStyle,
      )
      .toBe("shapes");
    await expect(pixelOf(page, "Gatinho")).toHaveCount(0);
  });

  test("reduced motion: the pixel avatar is still", async ({ page }) => {
    await freshBot(world, "Quieto", { avatar: "mascot:folha", avatarStyle: "pixel" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, world);
    await expect(pixelOf(page, "Quieto")).toHaveAttribute("data-mode", "still");
    const read = await readCanvas(pixelOf(page, "Quieto").locator("canvas"));
    expect(read.colors["2fb36b"] ?? 0).toBeGreaterThan(100);
  });

  for (const size of SIZES) {
    test(`screenshots at ${size.dir}`, async ({ browser }) => {
      const shots = await startWorld();
      try {
        const names = [
          ["Folha", "folha", null],
          ["Xícara", "xicara", null],
          ["Gato", "gato", "azul"],
          ["Polvo", "polvo", null],
          ["Robô", "robo", null],
          ["Cacto", "cacto", "rosa"],
        ] as const;
        for (const [name, id, color] of names)
          await shots.api.bots.create({
            name,
            description: `Mascote pixel ${id}`,
            modelId: "model-x",
            avatar: `mascot:${id}`,
            avatarStyle: "pixel",
            ...(color === null ? {} : { color }),
            pinned: true,
          });
        await shots.api.bots.create({
          name: "Formas",
          description: "O estilo de sempre",
          modelId: "model-x",
          avatar: "mascot:leaf",
          color: "verde",
        });
        const context = await browser.newContext({
          viewport: size.viewport,
          deviceScaleFactor: size.scale,
          locale: "pt-BR",
        });
        const page = await context.newPage();
        await openApp(page, shots);
        await expect(page.locator("[data-mascot-style=pixel]").first()).toBeVisible();
        await selectBot(page, "Folha");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `screenshots/${size.dir}/pixel-01-barra.png` });
        await page.getByRole("button", { name: "Novo bot" }).click();
        const dialog = page.getByRole("dialog", { name: "Criar novo Bot" });
        await dialog.getByRole("radio", { name: "Pixel" }).click();
        await dialog.getByRole("radio", { name: "Polvo" }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `screenshots/${size.dir}/pixel-02-seletor.png` });
        await dialog.getByRole("radio", { name: "Laranja" }).click();
        await page.waitForTimeout(300);
        await dialog.screenshot({ path: `screenshots/${size.dir}/pixel-03-seletor-cor.png` });
        await context.close();
      } finally {
        await shots.stop();
      }
    });
  }
});
