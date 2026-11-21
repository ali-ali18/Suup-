import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, openApp, openSettings, selectBot, send } from "./helpers.js";

// The welcome of a bot in the browser, against the real server and the scripted provider: the
// main bot's general welcome (questions as cards, one at a time, then ONE team card), the welcome of
// a bot with its own role, the yield to the user's own request, and "Refazer" in Configurações.
// The screenshots are for the design review against docs/DESIGN.md (apps/desktop/screenshots).

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const ask = (question: string, extra: object = {}) =>
  s({ calls: [{ name: "escalate", args: { questions: [{ question, ...extra }] } }] });
const PULAR = { label: "Pular" };
const draft = (name: string, description: string, personality: string) =>
  s({ calls: [{ name: "propose_bot", args: { name, description, personality } }] });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "first-conversation welcome",
        agent: [
          ask(
            "Oi! Eu sou o Principal, o assistente da sua equipe. Vou fazer algumas perguntas rápidas para te conhecer; dá para pular qualquer uma. Como você quer que eu te chame?",
          ),
          ask("Com o que você quer ajuda?", {
            options: [
              { label: "Faculdade e estudo" },
              { label: "Trabalho" },
              { label: "Código" },
              { label: "Finanças" },
              { label: "Casa e rotina" },
              PULAR,
            ],
            multiple: true,
            allowOther: true,
          }),
          ask("Como você gosta das respostas?", {
            options: [{ label: "Curtas" }, { label: "Detalhadas" }, { label: "Depende" }, PULAR],
          }),
          s({
            calls: [
              {
                name: "remember",
                args: { layer: "profile", text: "O usuário quer ser chamado de Marina." },
              },
            ],
          }),
          s({
            calls: [
              {
                name: "propose_team",
                args: {
                  bots: [
                    { brief: "Um tutor de faculdade que ajuda com disciplinas e prazos." },
                    { brief: "Um bot de finanças pessoais que organiza contas e gastos." },
                    { brief: "Um bot de rotina da casa que lembra tarefas." },
                  ],
                },
              },
            ],
          }),
          s({
            text: "Próximos passos, se quiser: conectar o seu e-mail, conectar um serviço ou criar uma rotina.\n\nPronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações.",
          }),
        ],
      },
      {
        whenObjectiveContains: "Descrição do bot que o usuário quer",
        agent: [],
        draft: [
          draft(
            "Tutor faculdade",
            "Ajuda com disciplinas, prazos e provas.",
            "Você é um tutor de faculdade, claro e paciente, que organiza estudos.",
          ),
          draft(
            "Finanças",
            "Organiza contas, gastos e metas do mês.",
            "Você cuida das finanças pessoais do usuário com cuidado e clareza.",
          ),
          draft(
            "Casa",
            "Lembra as tarefas e a rotina de casa.",
            "Você organiza a rotina da casa do usuário e lembra o que falta.",
          ),
        ],
      },
    ],
  },
  // A bot with its own role: a tutor of the college.
  outro: {
    cases: [
      {
        whenObjectiveContains: "first-conversation welcome",
        agent: [
          ask(
            "Oi! Sou o Tutor faculdade: ajudo com disciplinas, prazos e provas. Qual é o seu curso?",
          ),
          ask("Em que turno você estuda?", {
            options: [{ label: "Manhã" }, { label: "Tarde" }, { label: "Noite" }, PULAR],
            allowOther: true,
          }),
          s({
            calls: [
              {
                name: "remember",
                args: { layer: "note", text: "O usuário estuda Direito, à noite.", scope: "bot" },
              },
            ],
          }),
          s({ text: "Pronto: quando quiser, é só dizer qual matéria vem primeiro." }),
        ],
      },
    ],
  },
};

const shot = (name: string) => `screenshots/1440x900@2x/${name}.png`;

test.describe("the welcome of a bot", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  test.describe.configure({ mode: "serial" });
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS, reception: true });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("the main bot welcomes with cards, one at a time, then proposes a team the user ticks", async ({
    page,
  }) => {
    await openApp(page, world);
    await selectBot(page, "Principal");

    // The bot starts by itself, with a greeting that is part of its first question (free text).
    await expect(page.getByTestId("message-bot").first()).toContainText("Eu sou o Principal");
    await expect(page.getByTestId("question-card")).toHaveCount(0);
    await send(page, "Marina");

    // The second question is a card with options, and only that one is open.
    const card = page.getByTestId("question-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Com o que você quer ajuda?");
    await expect(card).toHaveAttribute("data-state", "open");
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("recepcao-principal-pergunta") });
    await page.getByTestId("question-option").filter({ hasText: "Faculdade e estudo" }).click();
    await page.getByTestId("question-option").filter({ hasText: "Finanças" }).click();
    await card.getByRole("button", { name: "Enviar" }).click();

    // The third question: one click answers it.
    await expect(page.getByTestId("question-card").last()).toContainText("Como você gosta");
    await page.getByTestId("question-option").filter({ hasText: "Curtas" }).click();

    // The team card: one card, title and light line, a row per bot, nothing ticked.
    const team = page.getByTestId("team-card");
    await expect(team).toBeVisible();
    await expect(team).toHaveAttribute("data-state", "needs-action");
    await expect(team.getByTestId("decision-title")).toHaveText("Montei uma equipe para você");
    await expect(team.getByTestId("team-row")).toHaveCount(3);
    await expect(team.getByTestId("team-create")).toBeDisabled();
    await expect(page.getByTestId("message-bot").last()).toContainText("Próximos passos");
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("recepcao-principal-equipe") });

    // Tick two, create: only those bots exist, and the card becomes one line.
    const before = (await world.api.bots.list()).length;
    await team.getByLabel("Criar Tutor faculdade").check();
    await team.getByLabel("Criar Casa").check();
    await expect(team.getByTestId("team-create")).toBeEnabled();
    await team.getByTestId("team-create").click();
    await expect(page.getByTestId("team-card")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("team-card")).toContainText(
      "Criou 2 bots: Tutor faculdade, Casa",
    );
    await expect(botItem(page, "Tutor faculdade")).toBeVisible();
    await expect(botItem(page, "Casa")).toBeVisible();
    await expect(botItem(page, "Finanças")).toHaveCount(0);
    expect((await world.api.bots.list()).length).toBe(before + 2);

    // The closing line is there and nothing in the chat said that something was saved.
    await expect(page.getByTestId("chat-log")).toContainText(
      "Pronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações.",
    );
    await expect(page.getByTestId("chat-log")).not.toContainText("Salvei");

    // What it learned is in the memory, written by the bot itself.
    const profile = await world.api.memories.list({ layer: "profile" });
    expect(profile.map((m) => m.text)).toContain("O usuário quer ser chamado de Marina.");
  });

  test("a bot with its own role asks about its role, and the card can be skipped", async ({
    page,
  }) => {
    await world.api.bots.create({
      name: "Tutor da turma",
      description: "Professor de várias matérias da faculdade",
      personality: "Você ajuda com estudos.",
      modelId: "model-y",
      allowedTools: ["remember"],
      avatar: "mascot:teardrop",
      color: "cinza",
    });
    await openApp(page, world);
    await selectBot(page, "Tutor da turma");
    await expect(page.getByTestId("message-bot").first()).toContainText("Qual é o seu curso?");
    await send(page, "Direito");
    const card = page.getByTestId("question-card");
    await expect(card).toContainText("Em que turno você estuda?");
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("recepcao-tutor-faculdade") });
    await page.getByTestId("question-option").filter({ hasText: "Pular" }).click();
    await expect(page.getByTestId("chat-log")).toContainText("Pronto: quando quiser");
    // Only its two questions: one at a time, never more than three.
    await expect(page.getByTestId("question-card")).toHaveCount(1);
    const notes = await world.api.memories.list({
      botId: (await world.api.bots.list()).find((b) => b.name === "Tutor da turma")?.id as string,
    });
    expect(notes.map((m) => m.text)).toContain("O usuário estuda Direito, à noite.");
  });

  test("with a card open the user can write something else: it reaches the same run, as the answer", async ({
    page,
  }) => {
    await world.api.bots.create({
      name: "Direto ao ponto",
      description: "Responde logo.",
      personality: "Você é direto.",
      modelId: "model-y",
      allowedTools: ["remember"],
    });
    await openApp(page, world);
    await selectBot(page, "Direto ao ponto");
    await expect(page.getByTestId("message-bot").first()).toContainText("Qual é o seu curso?");
    await send(page, "Direito");
    await expect(page.getByTestId("question-card")).toContainText("Em que turno você estuda?");
    // The composer says it is open to something else, and what is written is accepted at once.
    await expect(page.getByLabel("Mensagem", { exact: true })).toHaveAttribute(
      "placeholder",
      "Digite sua resposta ou fale sobre outra coisa",
    );
    await send(page, "Na verdade, preciso de outra coisa primeiro");
    await expect(page.getByTestId("question-card")).toHaveAttribute("data-state", "answered");
    await expect(page.getByTestId("chat-log")).toContainText("Pronto: quando quiser");
    // One run: the foreground run of the chat took the message (no second run), and it is over.
    const bot = (await world.api.bots.list()).find((b) => b.name === "Direto ao ponto");
    const runs = (await world.api.runs.list({ botId: bot?.id as string, limit: 20 })).items;
    expect(runs.map((r) => r.origin)).toEqual(["reception"]);
    await expect
      .poll(
        async () => (await world.api.conversations.get(bot?.conversationId as string)).reception,
      )
      .toBe("done");
    // Reopening never starts a second welcome.
    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await selectBot(page, "Direto ao ponto");
    await expect(page.getByTestId("chat-log")).toContainText("Pronto: quando quiser");
    const after = (await world.api.runs.list({ botId: bot?.id as string, limit: 20 })).items;
    expect(after).toHaveLength(1);
  });

  test("Configurações shows the time zone and lets the user redo the welcome of a bot", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Geral");
    await expect(page.getByTestId("time-zone")).not.toHaveText("…");
    const info = await world.api.info();
    await expect(page.getByTestId("time-zone")).toHaveText(info.timeZone);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("recepcao-configuracoes") });
    const row = page.getByTestId("reception-row").filter({ hasText: "Tutor da turma" });
    await row.getByTestId("reception-redo").click();
    await expect(page.getByText("a recepção recomeça")).toBeVisible();
    const tutor = (await world.api.bots.list()).find((b) => b.name === "Tutor da turma");
    const conversation = await world.api.conversations.get(tutor?.conversationId as string);
    expect(conversation.reception).toBe("redo");
  });
});
