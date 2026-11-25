import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { freshBot, openSettings, passWelcome } from "./helpers.js";
import { installTauriMock } from "./tauri-mock.js";

// The first-run choice and Settings > Servidor, with the Tauri shell played by `tauri-mock.ts`
// ("neste computador" reaches the real test server after the stages the real shell reports).
test.describe("first run: this computer or a VPS", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
    // The server already has a bot: the entrance goes to the app once connected.
    await freshBot(world, "Primeiro");
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("nothing saved: the choice, then the key (once, never shown back), the start and the app", async ({
    page,
  }) => {
    await installTauriMock(page, world, {
      isolation: { mode: "docker", reason: null, detail: null },
      welcome: true,
    });
    await page.goto(world.appUrl);
    // A device that never saw the welcome starts there; the first-run choice comes after it.
    await expect(page.getByTestId("first-run")).toHaveCount(0);
    await passWelcome(page);
    await expect(page.getByTestId("first-run")).toBeVisible();
    await expect(page.getByTestId("choose-local")).toContainText("Usar neste computador");
    await expect(page.getByTestId("choose-vps")).toContainText("Conectar à minha VPS");
    await page.getByTestId("choose-local").click();
    // The key step: a password field; the text is not kept anywhere the page can read back.
    const key = page.getByTestId("api-key-input");
    await expect(key).toHaveAttribute("type", "password");
    await key.fill("sk-ant-chave-de-teste");
    await page.getByRole("button", { name: "Guardar e continuar" }).click();
    await expect(page.getByTestId("local-start")).toBeVisible();
    await expect(page.getByTestId("local-stage")).toContainText("banco de dados");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // Settings > Geral > Servidor: the mode, the state, the machine of the bots, the key (not shown).
    await openSettings(page, "Geral");
    await expect(page.getByTestId("server-mode")).toContainText("Neste computador");
    await expect(page.getByTestId("local-state")).toContainText("Rodando");
    await expect(page.getByTestId("local-machine")).toContainText("Isolada (Docker)");
    await expect(page.getByTestId("local-warning")).toHaveCount(0);
    await expect(page.getByTestId("server-group")).not.toContainText("sk-ant");
  });

  test("a reopened app goes straight to the saved mode; no isolation is said truthfully", async ({
    page,
  }) => {
    await installTauriMock(page, world, {
      isolation: { mode: "local", reason: "docker_missing", detail: null },
    });
    await page.goto(world.appUrl);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("key-later").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // Once, the truthful warning about running without isolation; "Entendi" and it does not come back.
    await expect(page.getByTestId("isolation-notice")).toContainText(
      "rodam diretamente neste computador",
    );
    await page.getByTestId("isolation-ok").click();
    await page.reload();
    await expect(page.getByTestId("first-run")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page, "Geral");
    await expect(page.getByTestId("local-machine")).toContainText("Sem isolamento");
    await expect(page.getByTestId("local-machine")).toContainText("Docker");
    await expect(page.getByTestId("local-warning")).toContainText(
      "rodam diretamente neste computador",
    );
    // The key can be set afterwards, from here.
    await page.getByTestId("api-key-open").click();
    await page.getByTestId("api-key-input").fill("sk-ant-outra-chave");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByTestId("api-key-open")).toContainText("Trocar");
  });

  test("a start that fails says why, and retries on request", async ({ page }) => {
    await installTauriMock(page, world, {
      failFirstStartWith: "A porta do banco está ocupada.",
      welcome: true,
    });
    await page.goto(world.appUrl);
    await passWelcome(page);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("key-later").click();
    // one friendly sentence and the way to the logs; the supervisor's reason stays in the logs
    await expect(page.getByTestId("local-error")).toHaveText(
      "Algo impediu o Suup de iniciar neste computador. Tenta de novo?",
    );
    await expect(page.getByTestId("local-start")).not.toContainText("A porta do banco");
    await expect(page.getByTestId("local-start")).not.toContainText("/mock/logs");
    await expect(page.getByTestId("local-logs")).toHaveText("Abrir a pasta de registros");
    await page.getByTestId("local-retry").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("Trocar goes back to the choice; the VPS path connects with address and token", async ({
    page,
  }) => {
    await installTauriMock(page, world, { welcome: true });
    await page.goto(world.appUrl);
    await passWelcome(page);
    await page.getByTestId("choose-local").click();
    await page.getByTestId("key-later").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.getByTestId("isolation-ok").click();
    await openSettings(page, "Geral");
    await page.getByTestId("server-switch").click();
    await page.getByTestId("switch-confirm").click();
    await expect(page.getByTestId("first-run")).toBeVisible();
    await page.getByTestId("choose-vps").click();
    await expect(page.getByTestId("connect-back")).toBeVisible();
    await page.getByLabel("Endereço do servidor").fill(world.serverUrl);
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Token").fill(world.token);
    await page.getByRole("button", { name: "Conectar" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page, "Geral");
    await expect(page.getByTestId("server-mode")).toContainText("Minha VPS");
    await expect(page.getByTestId("server-url")).toHaveAttribute("title", world.serverUrl);
    await expect(page.getByTestId("server-url")).not.toContainText(world.serverUrl);
    await expect(page.getByTestId("local-state")).toHaveCount(0);
  });
});
