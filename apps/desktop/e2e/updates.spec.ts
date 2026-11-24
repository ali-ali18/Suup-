import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openSettings } from "./helpers.js";
import { installTauriMock, type MockOptions } from "./tauri-mock.js";

// The app's own update (docs/ATUALIZACAO.md, docs/DESIGN.md 3e), with the Tauri shell played by
// `tauri-mock.ts`: the quiet check finds a new version, the calm notice downloads it with a
// progress bar and installs it on "Reiniciar para concluir"; with the placeholder key nothing is
// asked and Settings only shows the version.
test.describe("app updates", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  async function intoTheApp(page: import("@playwright/test").Page, options: MockOptions) {
    await installTauriMock(page, world, {
      isolation: { mode: "docker", reason: null, detail: null },
      ...options,
    });
    await page.goto(world.appUrl);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("api-key-input").fill("sk-ant-chave-de-teste");
    await page.getByRole("button", { name: "Guardar e continuar" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
  }

  test("a new version: the notice, 'Atualizar agora', the progress, then 'Reiniciar para concluir' installs", async ({
    page,
  }) => {
    await intoTheApp(page, { update: { enabled: true, version: "0.2.0" } });
    const notice = page.getByTestId("update-notice");
    await expect(notice).toContainText("Nova versão do Suup disponível");
    await expect(notice).not.toContainText("github");
    await page.screenshot({ path: "test-results/update-notice.png" });
    await page.getByTestId("update-now").click();
    await expect(page.getByTestId("update-progress")).toBeVisible();
    await expect(page.getByTestId("update-restart")).toHaveText("Reiniciar para concluir");
    // Settings > Geral follows the same state.
    await openSettings(page, "Geral");
    await expect(page.getByTestId("update-row")).toContainText("Versão 0.1.0");
    await expect(page.getByTestId("update-row-action")).toHaveText("Reiniciar para concluir");
    await page.keyboard.press("Escape");
    await page.getByTestId("update-restart").click();
    await expect(notice).toHaveAttribute("data-phase", "installing");
    const installs = await page.evaluate(
      () => (window as unknown as { __updateInstalls: string[] }).__updateInstalls,
    );
    expect(installs).toEqual(["0.2.0"]);
  });

  test("'Depois' puts the notice away; the row in Settings still offers the update", async ({
    page,
  }) => {
    await intoTheApp(page, { update: { enabled: true, version: "0.2.0" } });
    await page.getByTestId("update-later").click();
    await expect(page.getByTestId("update-notice")).toHaveCount(0);
    await openSettings(page, "Geral");
    await expect(page.getByTestId("update-row-line")).toHaveText("A versão 0.2.0 está disponível.");
    await expect(page.getByTestId("update-row-action")).toHaveText("Atualizar agora");
  });

  test("the placeholder key: no notice, and Settings shows the version with no button", async ({
    page,
  }) => {
    await intoTheApp(page, {});
    await openSettings(page, "Geral");
    await expect(page.getByTestId("update-row")).toContainText("Versão 0.1.0");
    await expect(page.getByTestId("update-row-line")).toHaveText(
      "As atualizações automáticas ainda não estão ligadas.",
    );
    await expect(page.getByTestId("update-row-action")).toHaveCount(0);
    // Past the first quiet check, still nothing on the screen.
    await page.waitForTimeout(6_000);
    await expect(page.getByTestId("update-notice")).toHaveCount(0);
  });
});
