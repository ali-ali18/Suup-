import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send, userBubbles } from "./helpers.js";

// The progress watchdog, seen from the chat (docs/VIGIA.md): a bot that repeats the same call does
// NOT fail. The run stops and the chat shows the question card with the two options, a friendly
// line and a short account of what is done and left. "Continuar" lets the run go on;
// "Parar por aqui" (and the X) ends it cleanly, never as an error. No technical text anywhere.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const shell = (command: string) => ({ name: "shell", args: { command } });
const plan = (...steps: [string, string, string][]) => ({
  name: "plan",
  args: { steps: steps.map(([id, title, status]) => ({ id, title, status })) },
});

/** A bot that starts a plan and then repeats the same command until the watchdog stops it. */
const looping = (afterAnswer: object[]) => [
  s({
    text: "Vou planejar.",
    calls: [
      plan(["s1", "Preparar o arquivo", "done"], ["s2", "Conferir o resultado", "in_progress"]),
    ],
  }),
  ...Array.from({ length: 5 }, () => s({ calls: [shell("echo ping")] })),
  ...afterAnswer.map((step) => s(step)),
];

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-LACO-CONTINUAR",
        agent: looping([
          {
            calls: [
              plan(["s1", "Preparar o arquivo", "done"], ["s2", "Conferir o resultado", "done"]),
              { name: "finish", args: { summary: "Mudei de abordagem e terminei.", evidence: [] } },
            ],
          },
        ]),
      },
      { whenObjectiveContains: "CASE-LACO-PARAR", agent: looping([{ text: "nunca chega" }]) },
      { whenObjectiveContains: "CASE-LACO-FECHAR", agent: looping([{ text: "nunca chega" }]) },
    ],
  },
};

/** What a person must never read in the chat for this (the owner's rule: friendly, no technical text). */
const TECHNICAL = [
  "turn limit",
  "origem",
  "origin",
  "limit reached",
  "progress_limit",
  "watchdog",
  "waiting_user",
];

test.describe("o vigia de progresso", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  async function latestRun() {
    return (await world.api.runs.list({ limit: 1 })).items[0];
  }

  test("repetir a mesma coisa pergunta ao dono; Continuar dá +25 passos e a execução segue", async ({
    page,
  }) => {
    await openWithBot(page, world, "Repetidor");
    await send(page, "CASE-LACO-CONTINUAR confira o arquivo");

    // The question card: its title is the question; the options are the owner's decision.
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    await expect(card.getByTestId("question-text")).toHaveText("Quer que eu continue?");
    const options = card.getByTestId("question-option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText("Continuar");
    await expect(options.nth(1)).toContainText("Parar por aqui");
    await expect(card.getByTestId("question-dismiss")).toBeVisible();
    // The hint sits right under the card, outside it (docs/DESIGN.md, "Pergunta com opções").
    await expect(page.getByTestId("chat")).toContainText("Ou responda no chat abaixo");

    // One friendly line, and what is done and left, in the bot's bubble above the card.
    const lead = page
      .getByTestId("message-bot")
      .filter({ hasText: "Acho que estou andando em círculos." });
    await expect(lead).toContainText("Já fiz: Preparar o arquivo.");
    await expect(lead).toContainText("Falta: Conferir o resultado.");
    // The run is paused, not failed.
    await expect.poll(async () => (await latestRun())?.status).toBe("waiting_user");
    const chat = page.getByTestId("chat");
    for (const word of TECHNICAL) await expect(chat).not.toContainText(word);

    // For the visual review against the owner's references (1440x900 at 2x).
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "screenshots/1440x900@2x/vigia-pergunta-continuar-ou-parar.png",
    });

    await options.nth(0).click();
    await expect(userBubbles(page).last()).toHaveText("Continuar");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Mudei de abordagem e terminei." }),
    ).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect.poll(async () => (await latestRun())?.status).toBe("done");
    for (const word of TECHNICAL) await expect(chat).not.toContainText(word);

    // In the log (the Inspector): the decision and the 25 steps.
    const run = await latestRun();
    const events = (await world.api.runs.events(run?.id ?? "", { limit: 1000 })).items;
    const decided = events.find((e) => e.type === "progress_decided");
    expect(decided?.payload).toMatchObject({ choice: "continue", grant: 25 });
    expect(events.some((e) => e.type === "progress_check")).toBe(true);
  });

  test("Parar por aqui termina a execução limpa, com uma mensagem amigável e sem erro", async ({
    page,
  }) => {
    await openWithBot(page, world, "Parador");
    await send(page, "CASE-LACO-PARAR confira o arquivo");
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    await card.getByTestId("question-option").filter({ hasText: "Parar por aqui" }).click();

    await expect(userBubbles(page).last()).toHaveText("Parar por aqui");
    const closing = page
      .getByTestId("message-bot")
      .filter({ hasText: "Parei por aqui, como você pediu." });
    await expect(closing).toBeVisible();
    await expect(closing).toContainText("Já fiz: Preparar o arquivo.");
    await expect.poll(async () => (await latestRun())?.status).toBe("done");
    const chat = page.getByTestId("chat");
    for (const word of TECHNICAL) await expect(chat).not.toContainText(word);
    // Not an error: nothing in the chat says the task failed.
    await expect(chat).not.toContainText("não conseguiu");
    await expect(chat).not.toContainText("Algo deu errado");

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: "screenshots/1440x900@2x/vigia-parou-por-aqui.png" });
  });

  test("fechar o cartão com o X também para, sem gastar mais nada", async ({ page }) => {
    await openWithBot(page, world, "Fechador");
    await send(page, "CASE-LACO-FECHAR confira o arquivo");
    const card = page.getByTestId("question-card");
    await expect(card).toHaveAttribute("data-state", "open");
    await card.getByTestId("question-dismiss").click();
    await expect(card).toHaveAttribute("data-state", "dismissed");
    await expect(card).toContainText("Não respondido");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Parei por aqui, como você pediu." }),
    ).toBeVisible();
    await expect.poll(async () => (await latestRun())?.status).toBe("done");
    await expect(page.getByTestId("chat")).not.toContainText("nunca chega");
  });
});
