import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  closeSettings,
  freshBot,
  openApp,
  openSettings,
  openWithBot,
  selectBot,
  send,
} from "./helpers.js";

// The memory in the browser, against the real server: Configurações > Memória (every setting changes,
// survives a reload, and the server's range error is shown under its row), the memory screen with a
// note's fact line, and the history of a memory with its undo. Nothing asks about a memory in the chat.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-NOTA",
        agent: [
          s({
            calls: [
              {
                name: "remember",
                args: {
                  layer: "note",
                  text: "O deploy fica em tools/deploy.sh",
                  summary: "Deploy em tools/deploy.sh",
                },
              },
            ],
          }),
          s({ text: "Anotei." }),
        ],
      },
    ],
  },
};
const SHOTS = "screenshots/1440x900@2x";

async function openMemoryScreen(page: Page): Promise<void> {
  await page.getByTestId("owner-menu").click();
  await page.getByRole("menuitem", { name: "Memória" }).click();
  await expect(page.getByTestId("memory-screen")).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

test.describe("Memória", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("Configurações > Memória: each setting changes, survives a reload, and a range error comes from the server", async ({
    page,
  }) => {
    await openWithBot(page, world, "Lembrador");
    await openSettings(page, "Memória");
    const panel = page.getByTestId("settings-panel-memory");
    await expect(panel.locator("h3")).toHaveText(["Consolidação", "Contexto", "Validade"]);
    await expect(page.locator("select")).toHaveCount(0);
    // The server's defaults.
    await expect(page.getByTestId("memory-enabled")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("memory-max-turns")).toHaveValue("15");
    await expect(page.getByTestId("memory-idle-minutes")).toHaveValue("5");
    await expect(page.getByTestId("memory-compaction")).toHaveValue("80");
    await expect(page.getByTestId("memory-prompt-limit")).toHaveValue("200");
    await expect(page.getByTestId("memory-usage")).toContainText("de 200");
    await expect(page.getByTestId("memory-expiry-days")).toHaveText("90 dias");
    // No model for the consolidation in this server: the faded line says why.
    await expect(page.getByTestId("memory-reviewer-unavailable")).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/40-config-memoria.png` });

    await page.getByTestId("memory-max-turns").fill("20");
    await page.getByTestId("memory-max-turns").press("Enter");
    await page.getByTestId("memory-idle-minutes").fill("7");
    await page.getByTestId("memory-idle-minutes").blur();
    await page.getByTestId("memory-compaction").fill("70");
    await page.getByTestId("memory-compaction").press("Enter");
    await page.getByTestId("memory-prompt-limit").fill("150");
    await page.getByTestId("memory-prompt-limit").press("Enter");
    await page.getByTestId("memory-expiry-days").click();
    await page.getByRole("option", { name: "180 dias", exact: true }).click();
    await page.getByTestId("memory-enabled").click();
    await expect(page.getByTestId("memory-enabled")).toHaveAttribute("aria-checked", "false");
    await expect(panel.locator('[role="alert"]')).toHaveCount(0);
    // The server has them.
    await expect
      .poll(async () => {
        const settings = await world.api.memorySettings.get();
        return JSON.stringify([
          settings.consolidation,
          settings.compactionThreshold,
          settings.promptLimitItems,
          settings.expiryDays,
        ]);
      })
      .toBe(JSON.stringify([{ enabled: false, idleMinutes: 7, maxTurns: 20 }, 0.7, 150, 180]));

    // After a reload (a fresh read) they are still there.
    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await openSettings(page, "Memória");
    await expect(page.getByTestId("memory-max-turns")).toHaveValue("20");
    await expect(page.getByTestId("memory-idle-minutes")).toHaveValue("7");
    await expect(page.getByTestId("memory-compaction")).toHaveValue("70");
    await expect(page.getByTestId("memory-prompt-limit")).toHaveValue("150");
    await expect(page.getByTestId("memory-expiry-days")).toHaveText("180 dias");
    await expect(page.getByTestId("memory-enabled")).toHaveAttribute("aria-checked", "false");

    // "Nunca": null on the server.
    await page.getByTestId("memory-expiry-days").click();
    await page.getByRole("option", { name: "Nunca", exact: true }).click();
    await expect(page.getByTestId("memory-expiry-days")).toHaveText("Nunca");
    await expect.poll(async () => (await world.api.memorySettings.get()).expiryDays).toBeNull();

    // Out of range: the server's words under the row, and the old value comes back.
    await page.getByTestId("memory-max-turns").fill("500");
    await page.getByTestId("memory-max-turns").press("Enter");
    await expect(page.getByTestId("memory-error-maxTurns")).toContainText("entre 3 e 100");
    await expect(page.getByTestId("memory-max-turns")).toHaveValue("20");
    await expect(page.getByTestId("memory-max-turns")).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("memory-compaction").fill("40");
    await page.getByTestId("memory-compaction").press("Enter");
    await expect(page.getByTestId("memory-error-compaction")).toBeVisible();
    await expect(page.getByTestId("memory-compaction")).toHaveValue("70");
    await page.getByTestId("memory-idle-minutes").fill("abc");
    await page.getByTestId("memory-idle-minutes").press("Enter");
    await expect(page.getByTestId("memory-error-idleMinutes")).toHaveText("Digite um número.");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/41-config-memoria-erro.png` });
    expect((await world.api.memorySettings.get()).consolidation.maxTurns).toBe(20);
    await closeSettings(page);
  });

  test("a bot over the limit gets a warning row, and 'Ver memórias' opens the memory screen on it", async ({
    page,
  }) => {
    // The smallest limit (20 memories) and one more rule than it: every bot is over.
    await world.api.memorySettings.update({ promptLimitItems: 20 });
    const rules = [];
    for (let i = 1; i <= 21; i++) {
      rules.push(await world.api.memories.add({ layer: "rule", text: `Regra de teste ${i}.` }));
    }
    await openWithBot(page, world, "Estourado");
    await openSettings(page, "Memória");
    const rows = page.getByTestId("memory-over-limit");
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: "Estourado" })).toHaveCount(1);
    await expect(page.getByTestId("memory-usage")).toContainText("de 20");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/42-config-memoria-limite.png` });
    await rows.filter({ hasText: "Estourado" }).getByTestId("memory-over-limit-open").click();
    await expect(page.getByTestId("settings-screen")).toHaveCount(0);
    await expect(page.getByTestId("memory-screen")).toBeVisible();
    await expect(page.getByLabel("Filtrar por bot")).toContainText("Estourado");
    await world.api.memorySettings.update({ promptLimitItems: 200 });
    for (const rule of rules) await world.api.memories.archive(rule.id);
  });

  test("the memory screen shows a note's fact line; the history lists who changed what and undoes the latest", async ({
    page,
  }) => {
    await freshBot(world, "Anotador", { allowedTools: ["shell", "remember"] });
    await openApp(page, world);
    await selectBot(page, "Anotador");
    await send(page, "CASE-NOTA guarde isto");
    await expect(page.getByTestId("message-bot").filter({ hasText: "Anotei." })).toBeVisible();
    // Nothing in the chat asks about the memory.
    await expect(page.getByTestId("memory-card")).toHaveCount(0);

    const first = await world.api.memories.add({ layer: "rule", text: "Primeira versão da regra" });
    await world.api.memories.edit(first.id, "Segunda versão da regra");

    await openMemoryScreen(page);
    await page.getByRole("tab", { name: /Notas/ }).click();
    await expect(page.getByTestId("memory-summary")).toHaveText("Deploy em tools/deploy.sh");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/43-memoria-resumo.png` });

    await page.getByRole("tab", { name: /Regras/ }).click();
    const item = page.getByTestId("memory-item").filter({ hasText: "Segunda versão da regra" });
    await item.getByLabel("Histórico da memória").click();
    const dialog = page.getByRole("dialog", { name: "Histórico da memória" });
    const rows = dialog.getByTestId("memory-revision");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "edited");
    await expect(rows.nth(0)).toHaveAttribute("data-actor", "user");
    await expect(rows.nth(0)).toContainText("Antes: Primeira versão da regra");
    await expect(rows.nth(0)).toContainText("Agora: Segunda versão da regra");
    await expect(rows.nth(1)).toHaveAttribute("data-kind", "created");
    // Only the latest can be undone.
    await expect(dialog.getByTestId("memory-undo")).toHaveCount(1);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/44-memoria-historico.png` });

    await dialog.getByTestId("memory-undo").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "undone");
    await expect
      .poll(async () => (await world.api.memories.list()).map((m) => m.text))
      .toContain("Primeira versão da regra");
    await dialog.getByTestId("memory-history-close").click();
    await expect(
      page.getByTestId("memory-item").filter({ hasText: "Primeira versão da regra" }),
    ).toBeVisible();
    await expect(page.getByTestId("memory-item").filter({ hasText: "Segunda versão" })).toHaveCount(
      0,
    );
  });
});
