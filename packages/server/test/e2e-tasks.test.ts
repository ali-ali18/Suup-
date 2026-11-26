import { createBot, listMessages } from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// Tasks through the API, the worker and the stream (KOD-68): a chat opens a task with `start_task`,
// the task works in a conversation of its own while the chat stays free, the person answers it in
// its own view, it ends and the chat gets a short turn with the result. The model is scripted.

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const open = (title: string, marker: string) =>
  s({
    calls: [
      {
        name: "start_task",
        args: {
          title,
          objective: `${marker}: faça o trabalho longo pedido pelo usuário.`,
          deliver: "Um resumo curto do que foi feito.",
        },
      },
    ],
  });
const closing = s({ text: "A tarefa terminou e o resumo está pronto para você." });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        // First: the chat history of the other cases carries their words too.
        whenObjectiveContains: "CASE-OI",
        agent: Array.from({ length: 6 }, () => s({ text: "Oi! Estou aqui." })),
      },
      {
        // The turn that receives a report: the chat's earlier answers are turns of its history.
        whenObjectiveContains: "Report of the task",
        agent: [closing, closing, closing, closing, closing, closing],
      },
      {
        whenObjectiveContains: "TAREFA-REVISAO",
        agent: [s({ text: "Revisão pronta: três achados, o principal está no login." })],
      },
      {
        whenObjectiveContains: "TAREFA-PERGUNTA",
        agent: [
          s({ calls: [{ name: "escalate", args: { question: "Qual pasta devo usar?" } }] }),
          s({ text: "Usei a pasta que você indicou." }),
        ],
      },
      {
        whenObjectiveContains: "TAREFA-LONGA",
        agent: [s({ text: "Esta resposta nunca deve chegar.", delayMs: 120_000 })],
      },
      {
        whenObjectiveContains: "CASE-REVISAO",
        agent: [
          open("Revisar o projeto", "TAREFA-REVISAO"),
          s({ text: "Abri a tarefa de revisão." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-PERGUNTA",
        agent: [open("Organizar as pastas", "TAREFA-PERGUNTA"), s({ text: "Abri a tarefa." })],
      },
      {
        whenObjectiveContains: "CASE-LONGA",
        agent: [open("Trabalho demorado", "TAREFA-LONGA"), s({ text: "Abri a tarefa demorada." })],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("tasks through the API"), { timeout: 90_000 }, () => {
  const w = useWorld({ scripts: SCRIPTS });

  const botWithChat = async (name: string) => {
    const bot = await createBot(w.db, {
      name,
      modelProvider: "roteiro",
      modelId: "model-x",
      allowedTools: ["shell"],
    });
    const conversation = await w.started.api.bots.openConversation(bot.id);
    return { bot, chatId: conversation.id };
  };
  const botTexts = async (conversationId: string) =>
    (await listMessages(w.db, conversationId, { limit: 100 }))
      .filter((m) => m.authorKind === "bot")
      .map((m) => m.text);

  it("opens a task from the chat, works in its own conversation, and the chat gets the result", async () => {
    const { api } = w.started;
    const { chatId } = await botWithChat("Ajudante");
    const followed = follow(api);
    await api.conversations.send(chatId, "CASE-REVISAO: revise o projeto inteiro, por favor");
    const task = await until(
      async () => (await api.tasks.list({ conversationId: chatId }))[0],
      "the task",
    );
    expect(task).toMatchObject({ title: "Revisar o projeto", conversationId: chatId });
    // The conversation of the task is not in the list and takes no message from the chat path.
    expect((await api.conversations.list()).map((c) => c.id)).not.toContain(
      task.taskConversationId,
    );
    await expect(api.conversations.send(task.taskConversationId, "oi")).rejects.toMatchObject({
      status: 409,
    });
    // It ends, and the chat gets a short turn that is not the task's report itself.
    await until(
      async () =>
        (await botTexts(chatId)).includes("A tarefa terminou e o resumo está pronto para você."),
      "the closing turn in the chat",
    );
    const done = await api.tasks.get(task.id);
    expect(done.state).toBe("done");
    expect(done.closingRunId).not.toBeNull();
    expect(await botTexts(chatId)).not.toContain(
      "Revisão pronta: três achados, o principal está no login.",
    );
    // The full report stays in the conversation of the task.
    expect(
      (await api.conversations.messages(task.taskConversationId)).items.map((m) => m.text),
    ).toContain("Revisão pronta: três achados, o principal está no login.");
    // The stream carried the task (created, then its state).
    await followed.waitFor(
      (e) =>
        e.type === "task.changed" && e.data.task.id === task.id && e.data.task.state === "done",
      "the task as done on the stream",
    );
    expect(
      followed.events.some((e) => e.type === "task.changed" && e.data.change === "created"),
    ).toBe(true);
    // A task that ended takes no reply.
    await expect(api.tasks.reply(task.id, "ainda aí?")).rejects.toMatchObject({ status: 409 });
    followed.close();
  });

  it("a question of the task is answered in the task's own view: the reply goes straight to the task", async () => {
    const { api } = w.started;
    const { chatId } = await botWithChat("Organizador");
    await api.conversations.send(chatId, "CASE-PERGUNTA: organize as minhas pastas");
    const task = await until(
      async () => (await api.tasks.list({ conversationId: chatId }))[0],
      "the task",
    );
    await until(
      async () => (await api.tasks.get(task.id)).state === "waiting_user",
      "the task waiting",
    );
    // The chat is free and was not asked anything.
    expect(await botTexts(chatId)).not.toContain("Qual pasta devo usar?");
    // The question is a reply the person has not seen: the task says so until its view is opened.
    expect((await api.tasks.get(task.id)).unreadReplies).toBeGreaterThan(0);
    expect((await api.tasks.list({ conversationId: chatId }))[0]?.unreadReplies).toBeGreaterThan(0);
    const read = await api.tasks.markRead(task.id);
    expect(read.unreadReplies).toBe(0);
    expect((await api.tasks.get(task.id)).unreadReplies).toBe(0);
    const sent = await api.tasks.reply(task.id, "Use a pasta documentos.");
    expect(sent.message).toMatchObject({
      conversationId: task.taskConversationId,
      authorKind: "user",
      text: "Use a pasta documentos.",
    });
    await until(async () => (await api.tasks.get(task.id)).state === "done", "the task done");
    // What the task said after the person read it counts again.
    expect((await api.tasks.get(task.id)).unreadReplies).toBeGreaterThan(0);
    await expect(api.tasks.markRead("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await api.conversations.messages(task.taskConversationId)).items.map((m) => m.text),
    ).toEqual(
      expect.arrayContaining([
        "Qual pasta devo usar?",
        "Use a pasta documentos.",
        "Usei a pasta que você indicou.",
      ]),
    );
  });

  it("stops a task with the API: it ends as stopped and nothing is delivered to the chat", async () => {
    const { api } = w.started;
    const { chatId } = await botWithChat("Paciente");
    await api.conversations.send(chatId, "CASE-LONGA: faça o trabalho demorado");
    const task = await until(
      async () => (await api.tasks.list({ conversationId: chatId }))[0],
      "the task",
    );
    await until(async () => (await api.tasks.get(task.id)).state === "working" && true, "working");
    await api.tasks.stop(task.id);
    await until(async () => (await api.tasks.get(task.id)).state === "stopped", "the task stopped");
    // The chat answers new messages as usual, and has no report of the stopped task.
    await api.conversations.send(chatId, "CASE-OI");
    await until(
      async () => (await botTexts(chatId)).includes("Oi! Estou aqui."),
      "the chat answering",
    );
    expect(await botTexts(chatId)).toEqual(["Abri a tarefa demorada.", "Oi! Estou aqui."]);
    await expect(api.tasks.stop(task.id)).rejects.toMatchObject({ status: 409 });
  });
});
