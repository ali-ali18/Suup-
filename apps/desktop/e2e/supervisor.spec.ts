import { expect, test } from "@playwright/test";
import { addJournalMemory, addMemory } from "@suup/db";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, openApp, openSettings, principalBot, selectBot, send } from "./helpers.js";

// The Principal as the supervisor, in the browser, against the real server and the scripted
// provider: the delegation ("manda o Tutor...") and the result coming back, the nightly review with
// its morning message, the star on the avatar, the settings, and the memory housekeeping that stays
// out of the chat. The screenshots are for the design review against docs/DESIGN.md.

const usage = { inputTokens: 1200, outputTokens: 150 };
const s = <T extends object>(step: T) => ({ ...step, usage });

const SCRIPTS = {
  // The Principal (model-x).
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "manda o Tutor montar",
        agent: [
          s({
            calls: [
              {
                name: "delegate",
                args: {
                  bot: "Tutor",
                  objective: "Monte um cronograma de estudos para a prova de química de sexta.",
                  acceptanceCriteria: ["tem os dias e os temas de cada sessão"],
                  context: "A prova é na sexta. O usuário tem duas horas por noite.",
                },
              },
            ],
          }),
          s({
            text: "Passei para o Tutor montar o cronograma da prova de sexta. Quando ele terminar, o resumo aparece aqui.",
          }),
        ],
      },
      {
        // The review of the night: the model's answer (the forced tool `submit_team_review`).
        whenObjectiveContains: "Review of the night",
        agent: [],
        teamReview: [
          s({
            calls: [
              {
                name: "submit_team_review",
                args: {
                  notes: [
                    {
                      text: "Em 19/11 o Tutor montou o resumo de física; a prova de química é na sexta.",
                      summary: "Tutor: física pronta, química na sexta",
                    },
                    {
                      text: "O Finanças ainda espera uma resposta do usuário sobre o orçamento de dezembro.",
                      summary: "Finanças espera resposta sobre o orçamento",
                    },
                  ],
                  morning_message:
                    "Bom dia. O Finanças espera sua resposta sobre o orçamento de dezembro, e a prova de química é na sexta: o Tutor já tem o cronograma.",
                },
              },
            ],
          }),
        ],
      },
    ],
  },
  // The other bots (model-y).
  outro: {
    cases: [
      {
        whenObjectiveContains: "Task delegated by",
        // A delegated run has acceptance criteria: the plain answer is sent back once asking for
        // finish; this model answers in plain text again, which ends the run.
        agent: [
          s({
            text: "Cronograma da prova de sexta: segunda e terça, revisão dos capítulos 1 a 4; quarta, exercícios; quinta, simulado de duas horas.",
          }),
          s({
            text: "Cronograma da prova de sexta: segunda e terça, revisão dos capítulos 1 a 4; quarta, exercícios; quinta, simulado de duas horas.",
          }),
        ],
      },
      {
        whenObjectiveContains: "CASE-ANOTAR",
        agent: [
          s({
            calls: [
              {
                name: "remember",
                args: { layer: "note", text: "O usuário prefere estudar à noite.", scope: "bot" },
              },
            ],
          }),
          s({ calls: [{ name: "recall", args: { query: "estudar" } }] }),
          s({ text: "Anotado e conferido." }),
        ],
      },
    ],
  },
};

const shot = (name: string) => `screenshots/1440x900@2x/${name}.png`;

test.describe("the Principal as the supervisor", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  test.describe.configure({ mode: "serial" });
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS, supervisorEveryMs: 200 });
    await principalBot(world);
    // The review and the morning message are off until the test says so: nothing is due yet.
    await world.api.supervisor.settings.update({ reviewEnabled: false });
    await world.api.bots.create({
      name: "Tutor",
      description: "Ajuda com disciplinas, prazos e provas.",
      personality: "Você é um tutor de faculdade, claro e paciente.",
      modelId: "model-y",
      allowedTools: ["remember", "recall"],
      avatar: "mascot:teardrop",
      color: "cinza",
    });
    await world.api.bots.create({
      name: "Finanças",
      description: "Organiza contas, gastos e metas do mês.",
      personality: "Você cuida das finanças do usuário.",
      modelId: "model-y",
      allowedTools: ["remember", "recall"],
      avatar: "mascot:clover",
      color: "verde",
    });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the main bot has the star, in the sidebar and in the chat header; no other bot does", async ({
    page,
  }) => {
    await openApp(page, world);
    await expect(botItem(page, "Principal").getByTestId("supervisor-star")).toBeVisible();
    await expect(botItem(page, "Tutor").getByTestId("supervisor-star")).toHaveCount(0);
    await expect(botItem(page, "Finanças").getByTestId("supervisor-star")).toHaveCount(0);
    await selectBot(page, "Principal");
    await expect(page.getByTestId("bot-chip").getByTestId("supervisor-star")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("supervisor-estrela-barra-lateral") });
    // The panel of the bot has the large one.
    await expect(page.getByTestId("panel").getByTestId("supervisor-star")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("supervisor-estrela-painel") });
  });

  test("'manda o Tutor...': the Principal delegates, the run is in the Tutor's own chat, and the summary comes back", async ({
    page,
  }) => {
    await openApp(page, world);
    await selectBot(page, "Principal");
    await send(page, "manda o Tutor montar um cronograma da prova de química de sexta");
    // The Principal tells the user it delegated (it did not wait), and the result comes back here.
    await expect(page.getByTestId("chat-log")).toContainText("Passei para o Tutor");
    await expect(page.getByTestId("chat-log")).toContainText(
      "Tutor terminou a tarefa que pedi: Cronograma da prova de sexta",
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("supervisor-delegacao-resultado") });

    // In the Tutor's chat: the notice (visible there) and its own answer.
    await selectBot(page, "Tutor");
    await expect(page.getByTestId("chat-log")).toContainText("passou esta tarefa para Tutor");
    await expect(page.getByTestId("chat-log")).toContainText("quinta, simulado de duas horas");
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("supervisor-delegacao-chat-do-tutor") });

    const tutor = (await world.api.bots.list()).find((b) => b.name === "Tutor");
    const runs = (await world.api.runs.list({ botId: tutor?.id as string, limit: 10 })).items;
    expect(runs.map((r) => r.origin)).toEqual(["delegation"]);
    expect(runs[0]?.status).toBe("done");
  });

  test("the nightly review reads the others' journal and notes, notes in the Principal's own memory, and leaves ONE morning message", async ({
    page,
  }) => {
    const bots = await world.api.bots.list();
    const tutor = bots.find((b) => b.name === "Tutor");
    const fin = bots.find((b) => b.name === "Finanças");
    const principal = bots.find((b) => b.name === "Principal");
    // A week of made-up activity in two bots.
    for (const [bot, entries] of [
      [tutor, ["2026-11-19 · Conversa · Resultado: concluída. Resumo: montei o resumo de física"]],
      [fin, ["2026-11-20 · Conversa · Resultado: concluída. Resumo: listei as contas de dezembro"]],
    ] as const) {
      for (const text of entries) {
        // A run that already ended (inserted finished: a queued one would be taken by the worker).
        const [run] = await world.db.sql<{ id: string }[]>`
          insert into runs (bot_id, origin, objective, status, finished_at)
          values (${bot?.id as string}, 'user', 'x', 'done', now()) returning id`;
        await addJournalMemory(world.db, {
          botId: bot?.id as string,
          text,
          sourceRunId: (run as { id: string }).id,
        });
      }
    }
    await addMemory(world.db, {
      layer: "note",
      botId: tutor?.id as string,
      text: "A prova de química é na sexta.",
      createdBy: "bot",
    });
    await world.db.sql`delete from team_reviews`;
    await world.api.supervisor.settings.update({
      reviewEnabled: true,
      reviewTime: "00:00",
      morningTime: "00:00",
    });

    await expect
      .poll(async () => (await world.api.supervisor.reviews()).some((r) => r.status === "done"))
      .toBe(true);
    const [review] = await world.api.supervisor.reviews();
    expect(review?.botsRead.map((b) => b.name).sort()).toEqual(["Finanças", "Tutor"]);
    expect(review?.noted).toHaveLength(2);
    const notes = await world.api.memories.list({ layer: "note", botId: principal?.id as string });
    expect(notes).toHaveLength(2);

    await openApp(page, world);
    await selectBot(page, "Principal");
    await expect(page.getByTestId("chat-log")).toContainText(
      "Bom dia. O Finanças espera sua resposta",
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("supervisor-mensagem-da-manha") });
    // ONE message, not a notification storm.
    await expect(page.getByTestId("chat-log").getByText("Bom dia. O Finanças")).toHaveCount(1);
    expect((await world.api.supervisor.reviews()).filter((r) => r.status === "done")).toHaveLength(
      1,
    );
  });

  test("Configurações > Memória has the Principal's settings and the history of the reviews", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Memória");
    const group = page.getByTestId("supervisor-settings");
    await group.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("supervisor-review-time")).toHaveText("00:00");
    await expect(page.getByTestId("supervisor-cost-cap")).toHaveText("Sem teto");
    // Change the cost cap and the time; the server keeps them.
    await page.getByTestId("supervisor-cost-cap").click();
    await page.getByRole("option", { name: "US$ 0,50", exact: true }).click();
    await expect.poll(async () => (await world.api.supervisor.settings.get()).costCapUsd).toBe(0.5);
    await page.getByTestId("supervisor-cost-cap").click();
    await page.getByRole("option", { name: "Sem teto", exact: true }).click();
    await expect
      .poll(async () => (await world.api.supervisor.settings.get()).costCapUsd)
      .toBeNull();
    await page.getByTestId("supervisor-review-time").click();
    await page.getByRole("option", { name: "03:00", exact: true }).click();
    await expect
      .poll(async () => (await world.api.supervisor.settings.get()).reviewTime)
      .toBe("03:00");
    // The history: the night that just happened, with who was read, the notes and the message.
    const night = page.getByTestId("supervisor-review").first();
    await expect(night).toContainText("Leu");
    await expect(night).toContainText("Anotou: Em 19/11 o Tutor montou o resumo de física");
    await expect(night).toContainText("Mensagem da manhã: “Bom dia.");
    await night.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("supervisor-config-principal") });
    await group.scrollIntoViewIfNeeded();
    await page
      .getByTestId("supervisor-settings")
      .locator("xpath=..")
      .evaluate((el) => {
        el.scrollTop = 0;
      });
  });

  test("saving a memory leaves no row in the chat, and neither does reading one", async ({
    page,
  }) => {
    await world.api.bots.create({
      name: "Anotador",
      description: "Guarda o que o usuário conta.",
      personality: "Você anota.",
      modelId: "model-y",
      allowedTools: ["remember", "recall"],
    });
    await openApp(page, world);
    await selectBot(page, "Anotador");
    await send(page, "CASE-ANOTAR: prefiro estudar à noite");
    await expect(page.getByTestId("chat-log")).toContainText("Anotado e conferido.");
    // The note IS in the memory (the bot saved it), but the chat says nothing about saving.
    const anotador = (await world.api.bots.list()).find((b) => b.name === "Anotador");
    const memories = await world.api.memories.list({
      layer: "note",
      botId: anotador?.id as string,
    });
    expect(memories.map((m) => m.text)).toContain("O usuário prefere estudar à noite.");
    await expect(page.getByTestId("chat-log")).not.toContainText("Salvar na memória");
    await expect(page.getByTestId("chat-log")).not.toContainText("Salvando na memória");
    // Reading is no row either: the chat shows results only (the calls are in the Inspector).
    await expect(page.getByTestId("action-card")).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("supervisor-memoria-fora-do-chat") });
  });
});
