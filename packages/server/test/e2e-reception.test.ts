import type { Message, SuupClient } from "@suup/api";
import { appendMessage } from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// The welcome of a bot, end to end: the open of the chat starts it ONCE (two servers, many calls),
// the bot asks its questions one at a time with the question card, what it learns goes to memory
// without a word, the main bot shows ONE team card and only the ticked bots are created, each new
// bot has a welcome of its own, and "Refazer" starts it again. The model is the scripted provider.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const ask = (question: string, extra: object = {}) =>
  s({ calls: [{ name: "escalate", args: { questions: [{ question, ...extra }] } }] });

const SKIP = { label: "Pular" };

const SCRIPTS = {
  // The main bot (and every bot of this model) in its welcome.
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "first-conversation welcome",
        agent: [
          ask("Oi! Eu sou o Principal, seu assistente. Como você quer que eu te chame?"),
          ask("Com o que você quer ajuda?", {
            options: [{ label: "Faculdade" }, { label: "Trabalho" }, SKIP],
            multiple: true,
            allowOther: true,
          }),
          ask("Como você gosta das respostas?", {
            options: [{ label: "Curtas" }, { label: "Detalhadas" }, SKIP],
          }),
          s({
            calls: [
              {
                name: "remember",
                args: { layer: "profile", text: "O usuário quer ser chamado de Marina." },
              },
              {
                name: "remember",
                args: { layer: "rule", text: "Responder de forma curta." },
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
            text: "Próximos passos: conectar o seu e-mail, ou criar uma rotina.\n\nPronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações.",
          }),
        ],
      },
      {
        // The drafts of the team card (`propose_bot`), in the order of the briefs.
        whenObjectiveContains: "Descrição do bot que o usuário quer",
        agent: [],
        draft: [
          s({
            calls: [
              {
                name: "propose_bot",
                args: {
                  name: "Tutor faculdade",
                  description: "Estudo, disciplinas e prazos.",
                  personality: "Você é um tutor de faculdade, claro e paciente.",
                },
              },
            ],
          }),
          s({
            calls: [
              {
                name: "propose_bot",
                args: {
                  name: "Finanças",
                  description: "Contas e gastos do mês.",
                  personality: "Você cuida das finanças pessoais do usuário.",
                },
              },
            ],
          }),
          s({
            calls: [
              {
                name: "propose_bot",
                args: {
                  name: "Casa",
                  description: "Rotina e tarefas de casa.",
                  personality: "Você organiza a rotina da casa do usuário.",
                },
              },
            ],
          }),
        ],
      },
    ],
  },
  // A bot of its own role (a tutor): its welcome is about its area.
  outro: {
    cases: [
      {
        whenObjectiveContains: "first-conversation welcome",
        agent: [
          ask("Oi! Sou o tutor da faculdade: ajudo com disciplinas e prazos. Qual é o seu curso?"),
          ask("Em que turno você estuda?", {
            options: [{ label: "Manhã" }, { label: "Noite" }, SKIP],
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
          s({ text: "Pronto: pode começar a falar comigo quando quiser." }),
        ],
      },
      {
        whenObjectiveContains: "Preciso de outra coisa",
        agent: [s({ text: "Claro, vamos ao seu pedido." })],
      },
    ],
  },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the welcome of a bot, through the API and a worker in another process"),
  { timeout: 90_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS });

    const messagesOf = async (conversationId: string): Promise<Message[]> =>
      (await w.started.api.conversations.messages(conversationId, { limit: 100 })).items;
    const answerWhenAsked = async (conversationId: string, text: string, nth: number) => {
      // The nth question of the bot is in the chat as a message with `question`.
      await until(async () => {
        const all = await messagesOf(conversationId);
        return all.filter((m) => m.question !== undefined).length >= nth ? true : undefined;
      }, `question ${nth}`);
      await w.started.api.conversations.send(conversationId, text);
    };
    // The server creates no bot and marks none as main: the user does, so the test does too.
    const mainBot = async (api: SuupClient) => {
      const found = (await api.bots.list()).find((b) => b.isDefault);
      if (found !== undefined) return found;
      const created = await api.bots.create({
        name: "Principal",
        modelId: "model-x",
        allowedTools: ["remember", "recall"],
      });
      return api.bots.setDefault(created.id);
    };
    const runsOf = async (botId: string) =>
      (await w.started.api.runs.list({ botId, limit: 50 })).items;
    const eventsOf = async (
      runId: string,
      types: ("model_request" | "context_loaded" | "run_started")[],
    ) => (await w.started.api.runs.events(runId, { limit: 1000, types })).items;

    it("tells the app the user's time zone is not known yet: never the server's own", async () => {
      const info = await w.started.api.info();
      expect(info).toEqual({ timeZone: null, timeZoneSource: null, oauthCallback: "loopback" });
    });

    it("the main bot welcomes once, in one conversation, with its questions one at a time", async () => {
      const { api } = w.started;
      const main = await mainBot(api);
      expect(main).toBeDefined();
      const mainId = main?.id as string;
      const second = await w.startServer();

      // Two windows, two servers, many calls at once: one welcome.
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => api.bots.startReception(mainId)),
        ...Array.from({ length: 4 }, () => second.api.bots.startReception(mainId)),
      ]);
      expect(results.filter((r) => r.started)).toHaveLength(1);
      const conversationId = results[0]?.conversationId as string;
      expect(new Set(results.map((r) => r.conversationId)).size).toBe(1);
      expect(results.find((r) => r.started)?.runId).toEqual(expect.any(String));
      const welcomes = (await runsOf(mainId)).filter((r) => r.origin === "reception");
      expect(welcomes).toHaveLength(1);
      const runId = welcomes[0]?.id as string;

      expect((await api.conversations.get(conversationId)).reception).toBe("started");

      // Question 1 (free text), one at a time: only one question is open.
      await answerWhenAsked(conversationId, "Marina", 1);
      await answerWhenAsked(conversationId, "Faculdade", 2);
      const openNow = (await messagesOf(conversationId)).filter((m) => m.question !== undefined);
      expect(openNow).toHaveLength(2);
      await answerWhenAsked(conversationId, "Curtas", 3);

      // The team card, then the closing text. Nothing was said about memory.
      const done = await until(async () => {
        const all = await messagesOf(conversationId);
        return all.some((m) => m.text.startsWith("Próximos passos")) ? all : undefined;
      }, "the closing message");
      const card = done.find((m) => m.team !== undefined);
      expect(card?.team?.status).toBe("pending");
      expect(card?.team?.items.map((i) => i.name)).toEqual(["Tutor faculdade", "Finanças", "Casa"]);
      expect(done.map((m) => m.authorKind)).toEqual([
        "bot",
        "user",
        "bot",
        "user",
        "bot",
        "user",
        "bot",
        "bot",
      ]);
      expect(done.at(-1)?.text).toContain(
        "Pronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações.",
      );
      expect(done.some((m) => m.text.toLowerCase().includes("salvei"))).toBe(false);

      // The run ended, the welcome is over and never comes back by itself.
      await until(async () => (await api.runs.get(runId)).status === "done", "the run to end");
      expect((await api.conversations.get(conversationId)).reception).toBe("done");
      expect((await api.bots.startReception(mainId)).started).toBe(false);

      // What it learned is in memory, written by the bot itself.
      const memories = await api.memories.list({ layer: "profile" });
      expect(memories.map((m) => m.text)).toContain("O usuário quer ser chamado de Marina.");

      // What the run was told: the order of the blocks, the team (of the others), the tool.
      const [requested] = await eventsOf(runId, ["model_request"]);
      const payload = requested?.payload as { system: string; tools: { name: string }[] };
      expect(payload.system).toContain("## First conversation");
      expect(payload.system).toContain("call `propose_team` ONCE");
      expect(payload.tools.map((t) => t.name)).toContain("propose_team");
      const [loaded] = await eventsOf(runId, ["context_loaded"]);
      const context = loaded?.payload as {
        now: { iso: string; timeZone: string };
        team: unknown[];
        machine: { terminal: boolean; isolated: boolean };
        reception: string;
      };
      expect(context.reception).toBe("general");
      expect(context.now.timeZone).toEqual(expect.any(String));
      expect(context.machine.isolated).toBe(false);
      expect(payload.system).toContain("## Now");
      expect(payload.system).toContain("## Your team");
      expect(payload.system).toContain("## What you have");
    });

    it("creates only the ticked bots, through the normal path, and each new bot has its own welcome", async () => {
      const { api } = w.started;
      const main = await mainBot(api);
      const conversation = await api.bots.openConversation(main?.id as string);
      const card = (await messagesOf(conversation.id)).find((m) => m.team !== undefined);
      expect(card).toBeDefined();
      const before = (await api.bots.list()).length;

      // "Agora não" on a card that is still pending is a different test: this one ticks two.
      const decided = await api.conversations.decideTeam(card?.id as string, {
        create: [{ index: 0, avatar: "mascot:leaf", color: "verde" }, { index: 2 }],
      });
      expect(decided.bots.map((b) => b.name)).toEqual(["Tutor faculdade", "Casa"]);
      expect(decided.bots[0]).toMatchObject({
        avatar: "mascot:leaf",
        color: "verde",
        modelId: main?.modelId,
        description: "Estudo, disciplinas e prazos.",
      });
      expect(decided.message.team?.status).toBe("created");
      expect((await api.bots.list()).length).toBe(before + 2);
      expect((await api.bots.list()).some((b) => b.name === "Finanças")).toBe(false);

      // A second decision (a double click, another window) creates nothing.
      await expect(
        api.conversations.decideTeam(card?.id as string, { create: [{ index: 1 }] }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        api.conversations.decideTeam(card?.id as string, { dismiss: true }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await api.bots.list()).length).toBe(before + 2);

      // The new bot is welcomed in its own conversation, by a bot-kind welcome (no team card).
      const tutor = decided.bots[0];
      const welcome = await api.bots.startReception(tutor?.id as string);
      expect(welcome.started).toBe(true);
      const loaded = await until(async () => {
        const found = await eventsOf(welcome.runId as string, ["context_loaded"]);
        return found[0];
      }, "the welcome of the new bot to load its context");
      expect((loaded.payload as { reception: string }).reception).toBe("bot");
      const requested = await until(async () => {
        const found = await eventsOf(welcome.runId as string, ["model_request"]);
        return found[0];
      }, "the first request");
      const system = (requested.payload as { system: string }).system;
      expect(system).toContain("## First conversation");
      expect(system).not.toContain("propose_team");
      expect(system).toContain("You are Tutor faculdade");
    });

    it("'Agora não' creates nothing, and the card is decided once", async () => {
      const { api } = w.started;
      const main = await mainBot(api);
      const conversation = await api.bots.openConversation(main?.id as string);
      const card = await appendMessage(w.db, {
        conversationId: conversation.id,
        authorKind: "bot",
        authorBotId: main?.id as string,
        text: "Outra proposta.",
        team: [
          {
            name: "Viagens",
            description: "Planeja viagens.",
            personality: "Você planeja viagens.",
          },
        ],
      });
      const before = (await api.bots.list()).length;
      const dismissed = await api.conversations.decideTeam(card.id, { dismiss: true });
      expect(dismissed.bots).toEqual([]);
      expect(dismissed.message.team?.status).toBe("dismissed");
      expect((await api.bots.list()).length).toBe(before);
      await expect(
        api.conversations.decideTeam(card.id, { create: [{ index: 0 }] }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        api.conversations.decideTeam(card.id, { create: [{ index: 9 }] }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await api.bots.list()).length).toBe(before);
    });

    it("redo starts the welcome again, and is refused while it runs", async () => {
      const { api } = w.started;
      // The welcome of the main bot, redone.
      const main = await mainBot(api);
      const conversation = await api.bots.openConversation(main?.id as string);
      await until(
        async () =>
          (await api.runs.list({ botId: main?.id as string, limit: 50 })).items.every(
            (r) => r.status === "done" || r.status === "failed",
          ),
        "the main bot to be idle",
      );
      await api.bots.resetReception(main?.id as string);
      expect((await api.conversations.get(conversation.id)).reception).toBe("redo");
      const again = await api.bots.startReception(main?.id as string);
      expect(again.started).toBe(true);
      expect(again.runId).not.toBeNull();
      // It asks again (the redo objective says so, in the run).
      const started = await until(async () => {
        const found = await eventsOf(again.runId as string, ["run_started"]);
        return found[0];
      }, "the redo run to start");
      expect(JSON.stringify(started.payload)).toContain("asked to redo your welcome");
      expect((await api.conversations.get(conversation.id)).reception).toBe("started");
      // Redoing is refused while the welcome runs.
      await expect(api.bots.resetReception(main?.id as string)).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("a bot with its own role asks about its role, and a user's own request comes first", async () => {
      const { api } = w.started;
      const tutor = await api.bots.create({
        name: "Tutor",
        description: "Ajuda com a faculdade.",
        modelId: "model-y",
        allowedTools: ["remember"],
      });
      const started = await api.bots.startReception(tutor.id);
      expect(started.started).toBe(true);
      await answerWhenAsked(started.conversationId, "Direito", 1);
      await answerWhenAsked(started.conversationId, "Pular", 2);
      const all = await until(async () => {
        const found = await messagesOf(started.conversationId);
        return found.some((m) => m.text.startsWith("Pronto: pode começar")) ? found : undefined;
      }, "the end of the welcome");
      expect(all.filter((m) => m.question !== undefined)).toHaveLength(2);
      const note = await api.memories.list({ botId: tutor.id });
      expect(note.map((m) => m.text)).toContain("O usuário estuda Direito, à noite.");

      // A second bot: the user writes first. No welcome on top of the request.
      const other = await api.bots.create({
        name: "Outro",
        modelId: "model-y",
        allowedTools: [],
      });
      const conversation = await api.bots.openConversation(other.id);
      await api.conversations.send(conversation.id, "Preciso de outra coisa");
      expect((await api.conversations.get(conversation.id)).reception).toBe("done");
      expect((await api.bots.startReception(other.id)).started).toBe(false);
      await until(async () => {
        const found = await messagesOf(conversation.id);
        return found.some((m) => m.text === "Claro, vamos ao seu pedido.") ? true : undefined;
      }, "the bot to handle the request");
      const runs = await runsOf(other.id);
      expect(runs.map((r) => r.origin)).toEqual(["user"]);
    });
  },
);
