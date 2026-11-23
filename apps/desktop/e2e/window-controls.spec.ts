import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { installTauriMock } from "./tauri-mock.js";

// The window controls drawn by the app (minimize, maximize, close), inside the top right corner like
// the Grok Bot (owner's decision, 22/11/2026): only when the shell says the window has no system
// title bar; nothing in a browser or with a native frame; and they never sit on the panel's own
// close button.

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __windowCalls: string[] }).__windowCalls);

test.describe("window controls", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  async function intoTheApp(page: import("@playwright/test").Page): Promise<void> {
    await page.goto(world.appUrl);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("api-key-input").fill("sk-ant-chave-de-teste");
    await page.getByRole("button", { name: "Guardar e continuar" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
  }

  test("a custom frame: three buttons in the corner, each one asks the window; the panel's close stays clear of them", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTauriMock(page, world, {
      frame: "custom",
      isolation: { mode: "docker", reason: null, detail: null },
    });
    await page.goto(world.appUrl);
    // Even before the app (the first-run choice) the window can be closed and moved.
    const controls = page.getByTestId("window-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("button")).toHaveCount(3);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("api-key-input").fill("sk-ant-chave-de-teste");
    await page.getByRole("button", { name: "Guardar e continuar" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();

    const box = await controls.boundingBox();
    expect(box?.x).toBeCloseTo(1440 - 138, 0);
    expect(box?.y).toBe(0);
    expect(box?.height).toBe(32);

    await page.getByTestId("window-minimize").click();
    await page.getByTestId("window-maximize").click();
    await expect(page.getByTestId("window-maximize")).toHaveAttribute("data-maximized", "true");
    await expect(page.getByRole("button", { name: "Restaurar" })).toBeVisible();
    await page.getByTestId("window-maximize").click();
    await expect(page.getByRole("button", { name: "Maximizar" })).toBeVisible();
    await page.getByTestId("window-close").click();
    expect(await calls(page)).toEqual(["minimize", "toggle_maximize", "toggle_maximize", "close"]);

    // The panel's close button sits to the left of the strip, never under it.
    const panelClose = await page
      .getByTestId("panel")
      .getByRole("button", { name: "Fechar o painel" })
      .boundingBox();
    expect((panelClose?.x ?? 0) + (panelClose?.width ?? 0)).toBeLessThanOrEqual(box?.x ?? 0);
    // The top of the chat, the sidebar and the panel can be dragged: the window has no title bar.
    for (const id of ["sidebar", "panel"])
      await expect(page.getByTestId(id).locator("[data-tauri-drag-region]").first()).toBeAttached();
    await expect(page.locator("header[data-tauri-drag-region]").first()).toBeAttached();
  });

  test("a native frame (macOS): no controls of the app, and the panel's close keeps its place", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installTauriMock(page, world, {
      frame: "native",
      isolation: { mode: "docker", reason: null, detail: null },
    });
    await intoTheApp(page);
    await expect(page.getByTestId("window-controls")).toHaveCount(0);
    const close = await page
      .getByTestId("panel")
      .getByRole("button", { name: "Fechar o painel" })
      .boundingBox();
    expect((close?.x ?? 0) + (close?.width ?? 0)).toBeGreaterThan(1440 - 20 - 40);
  });
});
