import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openApp, openSettings, selectBot, send } from "./helpers.js";

// Routines in the browser (docs/ROTINAS.md), against the real server and the scripted provider: the
// user asks in the chat, the bot creates the routine (the Auto-review reviewer lets it, because the
// user asked) and says when; the Rotinas panel shows it in words; the time is forced due, the
// worker fires it and the answer lands in the chat; the history, the edit with structured fields,
// pause and the user's time zone in Configurações. The screenshots are for the design review.

const usage = { inputTokens: 900, outputTokens: 90 };
const s = <T extends object>(step: T) => ({ ...step, usage });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "vê meu calendário",
        agent: [
          s({
            calls: [
              {
                name: "create_routine",
                args: {
                  name: "Calendário da manhã",
                  instruction:
                    "ROTINA-CALENDARIO Veja o calendário de hoje do usuário e diga, em poucas linhas, o que ele tem.",
                  schedule: { kind: "daily", time: "08:00" },
                },
              },
            ],
          }),
          s({ text: "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?" }),
        ],
        autoReview: [
          s({
            calls: [
              {
                name: "review_call",
                args: { decision: "run", ruleId: null, reason: "Você pediu esta rotina." },
              },
            ],
          }),
        ],
      },
      {
        whenObjectiveContains: "ROTINA-CALENDARIO",
        agent: [
          s({
            calls: [{ name: "update_routine_state", args: { state: "Avisei do dentista." } }],
          }),
          s({ text: "Bom dia! Hoje você tem dentista às 15h e a entrega do relatório às 18h." }),
        ],
      },
    ],
  },
};

const shot = (name: string) => `screenshots/1440x900@2x/${name}.png`;

test.describe("routines", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  test.describe.configure({ mode: "serial" });
  // The user's computer is in Sao Paulo; the server's process is whatever it is.
  test.use({ timezoneId: "America/Sao_Paulo" });
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({
      scripts: SCRIPTS,
      autoReviewModel: "model-x",
      routinesEveryMs: 150,
    });
    await world.api.bots.create({
      name: "Agenda",
      description: "Cuida da agenda e dos compromissos.",
      personality: "Seja breve e organizado.",
      modelId: "model-x",
      allowedTools: [],
      avatar: "mascot:clover",
      color: "azul",
    });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("asked in the chat, the bot creates it and says when; the panel shows it in words", async ({
    page,
  }) => {
    await openApp(page, world);
    await selectBot(page, "Agenda");
    const panel = page.getByTestId("panel");
    await expect(panel.getByTestId("section-routines")).toContainText("Nenhuma rotina");
    await send(page, "vê meu calendário todo dia");
    await expect(page.getByTestId("chat-log")).toContainText(
      "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?",
    );
    const row = panel.getByTestId("routine-row");
    await expect(row).toHaveAttribute("data-routine", "Calendário da manhã");
    await expect(row.getByTestId("routine-schedule")).toHaveText("todo dia às 08:00");
    await expect(row.getByTestId("routine-next")).toContainText("Próxima:");
    await expect(row.getByTestId("routine-next")).toContainText("08:00");
    // the app sent this computer's zone when it connected: the routine is in it
    const [routine] = await world.api.routines.list();
    expect(routine?.timeZone).toBe("America/Sao_Paulo");
    expect(routine?.nextRunAt?.endsWith("T11:00:00.000Z")).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("rotinas-painel-criada") });
  });

  test("when it comes due it fires once, the answer lands in the chat, and the history says so", async ({
    page,
  }) => {
    await openApp(page, world);
    await selectBot(page, "Agenda");
    await world.db.sql`update routines set next_run_at = now() - interval '1 second'`;
    await expect(page.getByTestId("chat-log")).toContainText(
      "Hoje você tem dentista às 15h e a entrega do relatório às 18h.",
    );
    const row = page.getByTestId("panel").getByTestId("routine-row");
    await expect(row.getByTestId("routine-last")).toContainText("Concluída");
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("rotinas-resultado-no-chat") });

    await page.getByRole("button", { name: "Ações da rotina Calendário da manhã" }).click();
    await page.getByRole("menuitem", { name: "Histórico" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("routine-fire")).toHaveCount(1);
    await expect(dialog.getByTestId("routine-fire")).toHaveAttribute("data-status", "done");
    await expect(dialog).toContainText("Bom dia! Hoje você tem dentista às 15h");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-historico") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    const [routine] = await world.api.routines.list();
    expect(routine?.state).toBe("Avisei do dentista.");
    const runs = (await world.api.runs.list({ botId: routine?.botId as string, limit: 10 })).items;
    expect(runs.map((r) => r.origin).sort()).toEqual(["routine", "user"]);
  });

  test("edit WHEN with the structured fields, then pause and resume", async ({ page }) => {
    await openApp(page, world);
    await selectBot(page, "Agenda");
    const panel = page.getByTestId("panel");
    await page.getByRole("button", { name: "Ações da rotina Calendário da manhã" }).click();
    await page.getByRole("menuitem", { name: "Editar" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("routine-kind").click();
    await page.getByRole("option", { name: "Toda semana" }).click();
    await dialog.getByRole("button", { name: "quarta" }).click();
    await dialog.getByRole("button", { name: "sexta" }).click();
    await dialog.getByTestId("routine-hour").click();
    await page.getByRole("option", { name: "07", exact: true }).click();
    await dialog.getByTestId("routine-minute").click();
    await page.getByRole("option", { name: "30", exact: true }).click();
    // The end date: chosen in dropdowns (day, month by name, year), never typed.
    const nextYear = new Date().getFullYear() + 1;
    await dialog.getByTestId("routine-ends").click();
    await page.getByRole("option", { name: "Numa data" }).click();
    await dialog.getByTestId("routine-until-year").click();
    await page.getByRole("option", { name: String(nextYear), exact: true }).click();
    await dialog.getByTestId("routine-until-month").click();
    await page.getByRole("option", { name: "dezembro" }).click();
    await dialog.getByTestId("routine-until-day").click();
    await page.getByRole("option", { name: "31", exact: true }).click();
    await expect(dialog.getByTestId("routine-preview")).toContainText(
      "toda segunda, quarta e sexta às 07:30",
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-editar") });
    await dialog.getByTestId("routine-save").click();
    await expect(dialog).toHaveCount(0);
    const row = panel.getByTestId("routine-row");
    await expect(row.getByTestId("routine-schedule")).toHaveText(
      `toda segunda, quarta e sexta às 07:30, até 31/12/${nextYear}`,
    );
    const [routine] = await world.api.routines.list();
    expect(routine?.schedule).toEqual({
      kind: "weekly",
      days: ["mon", "wed", "fri"],
      time: "07:30",
      until: `${nextYear}-12-31`,
    });

    await page.getByRole("button", { name: "Ações da rotina Calendário da manhã" }).click();
    await page.getByRole("menuitem", { name: "Pausar" }).click();
    await expect(row.getByTestId("routine-next")).toHaveText("Pausada");
    await expect(row).toHaveAttribute("data-status", "paused");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-painel-pausada") });
    await page.getByRole("button", { name: "Ações da rotina Calendário da manhã" }).click();
    await page.getByRole("menuitem", { name: "Retomar" }).click();
    await expect(row.getByTestId("routine-next")).toContainText("Próxima:");
  });

  test("Configurações > Geral: the user's time zone, from this computer, can be changed", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Geral");
    await expect(page.getByTestId("time-zone")).toHaveText("America/Sao_Paulo");
    await expect(page.getByTestId("time-zone-source")).toHaveText("Do seu computador.");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-fuso-configuracoes") });
    await page.getByTestId("time-zone").click();
    await page.getByLabel("Filtrar: Fuso horário").fill("Lisbon");
    await page.getByRole("option", { name: "Europe/Lisbon" }).click();
    await expect(page.getByTestId("time-zone-source")).toHaveText("Escolhido por você.");
    expect((await world.api.info()).timeZone).toBe("Europe/Lisbon");
    // the computer's zone does not replace the user's choice on the next connection
    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await world.api.info()).toEqual({ timeZone: "Europe/Lisbon", timeZoneSource: "user" });
  });
});
