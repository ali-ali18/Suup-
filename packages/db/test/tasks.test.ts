import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  cancelRun,
  createBot,
  createDirectConversation,
  createRun,
  createTask,
  forwardToTask,
  getActiveConversationRun,
  getApproval,
  getConversation,
  getRun,
  getTask,
  listApprovals,
  listConversations,
  listMessages,
  listTasks,
  MAX_OPEN_TASKS,
  openTaskResult,
  peekInboxEntries,
  pendingTaskResults,
  postInbox,
  projectApprovalRequested,
  replyToTask,
  sendConversationMessage,
  setRunStatus,
  TaskError,
  taskStartContext,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("tasks of a bot (KOD-68)"), () => {
  const ctx = useIsolatedDb();
  let n = 0;

  /** A bot, its chat, and a chat run (`origin: user`) opened by one user message. */
  const chat = async () => {
    const bot = await createBot(ctx.db, {
      name: `b${++n}`,
      modelProvider: "f",
      modelId: "m",
    });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const sent = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "Faça uma revisão completa do projeto e me diga o que achou.",
    });
    return { bot, conversation, run: sent.run, message: sent.message };
  };
  const start = (
    c: Awaited<ReturnType<typeof chat>>,
    title = "Revisar o projeto",
    extra: { brief?: string; sourceMessageIds?: string[] } = {},
  ) =>
    createTask(ctx.db, {
      fromRunId: c.run.id,
      title,
      brief: extra.brief ?? `Objetivo: ${title}. Devolver um resumo curto.`,
      sourceMessageIds: extra.sourceMessageIds ?? [c.message.id],
    });
  const finish = async (runId: string, to: "done" | "failed" | "cancelled" = "done") => {
    await setRunStatus(ctx.db, runId, { from: "queued", to: "running" });
    if (to === "failed") {
      await setRunStatus(ctx.db, runId, {
        from: "running",
        to: "failed",
        failure: { origin: "model", detail: "x" },
      });
    } else {
      await setRunStatus(ctx.db, runId, { from: "running", to });
    }
  };

  it("runs outside the one-active-run index: the chat stays free while the task works", async () => {
    const c = await chat();
    const { task, run, created } = await start(c);
    expect(created).toBe(true);
    expect(run).toMatchObject({ origin: "task", botId: c.bot.id, status: "queued" });
    expect(run.conversationId).toBe(task.taskConversationId);
    expect(task.conversationId).toBe(c.conversation.id);

    // The chat run ends; the chat has no foreground run although the task is still queued.
    await finish(c.run.id);
    expect(await getActiveConversationRun(ctx.db, c.conversation.id)).toBeNull();
    // A new message in the chat opens a normal chat run, with the task still open.
    const next = await sendConversationMessage(ctx.db, {
      conversationId: c.conversation.id,
      text: "E o prazo?",
    });
    expect(next.queuedForRun).toBe(false);
    expect(next.run.origin).toBe("user");
    expect((await getRun(ctx.db, run.id))?.status).toBe("queued");
    // And the task conversation is never in the list and takes no message from the chat path.
    expect((await listConversations(ctx.db)).map((v) => v.id)).not.toContain(
      task.taskConversationId,
    );
    expect((await getConversation(ctx.db, task.taskConversationId))?.kind).toBe("task");
    await expect(
      sendConversationMessage(ctx.db, { conversationId: task.taskConversationId, text: "oi" }),
    ).rejects.toThrow();
  });

  it("starts the same task once and refuses more than three open tasks per bot", async () => {
    const c = await chat();
    const first = await start(c, "Tarefa 1");
    const again = await start(c, "Tarefa 1");
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    for (let i = 2; i <= MAX_OPEN_TASKS; i++) await start(c, `Tarefa ${i}`);
    await expect(start(c, "Tarefa extra")).rejects.toMatchObject({ code: "limit" });
    // One of them ends: a place opens.
    await finish(first.run.id);
    expect((await start(c, "Tarefa extra")).created).toBe(true);
    expect(await listTasks(ctx.db, { botId: c.bot.id, openOnly: true })).toHaveLength(
      MAX_OPEN_TASKS,
    );
  });

  it("refuses a task started from a task, and from a run that is not a chat run", async () => {
    const c = await chat();
    const { run } = await start(c);
    await expect(
      createTask(ctx.db, { fromRunId: run.id, title: "Outra", brief: "x", sourceMessageIds: [] }),
    ).rejects.toMatchObject({ code: "nested" });
    const routine = await createRun(ctx.db, { botId: c.bot.id, origin: "routine", objective: "r" });
    await expect(
      createTask(ctx.db, {
        fromRunId: routine.id,
        title: "Outra",
        brief: "x",
        sourceMessageIds: [],
      }),
    ).rejects.toMatchObject({ code: "not_chat" });
  });

  it("copies the cited user messages from the database, and refuses foreign or non-user ids", async () => {
    const c = await chat();
    const botMessage = await appendMessage(ctx.db, {
      conversationId: c.conversation.id,
      authorKind: "bot",
      authorBotId: c.bot.id,
      text: "Posso fazer isso.",
      runId: c.run.id,
    });
    const other = await chat();
    await expect(start(c, "A", { sourceMessageIds: [other.message.id] })).rejects.toMatchObject({
      code: "invalid_messages",
    });
    await expect(start(c, "B", { sourceMessageIds: [botMessage.id] })).rejects.toBeInstanceOf(
      TaskError,
    );
    const second = await appendMessage(ctx.db, {
      conversationId: c.conversation.id,
      authorKind: "user",
      text: "Use só a pasta docs.",
      status: "sent",
    });
    const { task, run } = await start(c, "C", { sourceMessageIds: [second.id, c.message.id] });
    const context = await taskStartContext(ctx.db, run.id);
    // The text is the stored one, in the order it was written, never what the model typed.
    expect(context?.userMessages).toEqual([
      { id: c.message.id, text: c.message.text },
      { id: second.id, text: "Use só a pasta docs." },
    ]);
    expect(context?.task.id).toBe(task.id);
    expect(await taskStartContext(ctx.db, c.run.id)).toBeNull();
  });

  it("puts a reply written in the task view straight into the task run's inbox", async () => {
    const c = await chat();
    const { task, run } = await start(c);
    const sent = await replyToTask(ctx.db, task.id, "Pode usar o Postgres.");
    expect(sent.message).toMatchObject({
      conversationId: task.taskConversationId,
      authorKind: "user",
      status: "sent",
      runId: run.id,
    });
    const inbox = await peekInboxEntries(ctx.db, run.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "user_message", text: "Pode usar o Postgres." });
    // Nothing reached the chat.
    const chatMessages = await listMessages(ctx.db, c.conversation.id, { limit: 50 });
    expect(chatMessages.map((m) => m.text)).not.toContain("Pode usar o Postgres.");
    // A task that waits for the user is woken by it.
    await setRunStatus(ctx.db, run.id, { from: "queued", to: "running" });
    await setRunStatus(ctx.db, run.id, { from: "running", to: "waiting_user" });
    await replyToTask(ctx.db, task.id, "Sim.");
    expect((await getRun(ctx.db, run.id))?.status).toBe("queued");
    // A task that ended takes no reply.
    await setRunStatus(ctx.db, run.id, { from: "queued", to: "running" });
    await setRunStatus(ctx.db, run.id, { from: "running", to: "done" });
    await expect(replyToTask(ctx.db, task.id, "Ainda aí?")).rejects.toMatchObject({
      code: "finished",
    });
  });

  it("forwards to a task by message id (verbatim) or by the bot's own words, only from its chat", async () => {
    const c = await chat();
    const { task, run } = await start(c);
    const said = await appendMessage(ctx.db, {
      conversationId: c.conversation.id,
      authorKind: "user",
      text: "Mude para o relatório em inglês.",
      status: "sent",
    });
    const byId = await forwardToTask(ctx.db, {
      taskId: task.id,
      fromConversationId: c.conversation.id,
      messageId: said.id,
    });
    expect(byId.verbatim).toBe(true);
    expect(byId.message.text).toBe("Mude para o relatório em inglês.");
    const byWords = await forwardToTask(ctx.db, {
      taskId: task.id,
      fromConversationId: c.conversation.id,
      text: "O usuário quer o prazo curto.",
    });
    expect(byWords.verbatim).toBe(false);
    expect(byWords.message.authorKind).toBe("bot");
    const inbox = await peekInboxEntries(ctx.db, run.id);
    expect(inbox.map((i) => (i.kind === "user_message" ? i.text : ""))).toEqual([
      "Mude para o relatório em inglês.",
      "[Note from the chat assistant, in its own words (not typed by the user)] O usuário quer o prazo curto.",
    ]);
    const other = await chat();
    await expect(
      forwardToTask(ctx.db, {
        taskId: task.id,
        fromConversationId: other.conversation.id,
        text: "oi",
      }),
    ).rejects.toMatchObject({ code: "wrong_chat" });
    await expect(
      forwardToTask(ctx.db, {
        taskId: task.id,
        fromConversationId: c.conversation.id,
        messageId: other.message.id,
      }),
    ).rejects.toMatchObject({ code: "invalid_messages" });
  });

  it("stops a task through the same cancellation as any run, and the chat is not touched", async () => {
    const c = await chat();
    const { run } = await start(c);
    const stopped = await cancelRun(ctx.db, run.id);
    expect(stopped.status).toBe("cancelled");
    expect((await getRun(ctx.db, c.run.id))?.status).toBe("queued");
  });

  it("delivers the result to the chat once, with a turn that is the chat's foreground run", async () => {
    const c = await chat();
    const { task, run } = await start(c);
    await finish(c.run.id);
    // Not finished yet: nothing to deliver.
    expect(await openTaskResult(ctx.db, task.id, "objective")).toEqual({ state: "nothing" });
    await finish(run.id);
    expect((await pendingTaskResults(ctx.db)).map((p) => p.task.id)).toContain(task.id);
    const opened = await openTaskResult(ctx.db, task.id, "RELATÓRIO");
    expect(opened.state).toBe("opened");
    if (opened.state !== "opened") return;
    expect(opened.run).toMatchObject({
      origin: "task_result",
      conversationId: c.conversation.id,
      objective: "RELATÓRIO",
    });
    expect((await getTask(ctx.db, task.id))?.closingRunId).toBe(opened.run.id);
    expect((await getActiveConversationRun(ctx.db, c.conversation.id))?.id).toBe(opened.run.id);
    // A second delivery (another worker, the crash recovery) opens nothing.
    expect(await openTaskResult(ctx.db, task.id, "RELATÓRIO")).toEqual({ state: "nothing" });
    expect((await pendingTaskResults(ctx.db)).map((p) => p.task.id)).not.toContain(task.id);
  });

  it("does not open a second foreground run while the chat is busy: the result waits and opens later", async () => {
    const c = await chat();
    const { task, run } = await start(c);
    await finish(run.id);
    // The chat run (c.run) is still queued: the chat is busy.
    expect(await openTaskResult(ctx.db, task.id, "RELATÓRIO")).toEqual({ state: "busy" });
    expect(
      (await pendingTaskResults(ctx.db, { conversationId: c.conversation.id })).map(
        (p) => p.task.id,
      ),
    ).toEqual([task.id]);
    await finish(c.run.id);
    const opened = await openTaskResult(ctx.db, task.id, "RELATÓRIO");
    expect(opened.state).toBe("opened");
  });

  it("shows the approval card of a task in the chat that asked for it", async () => {
    const c = await chat();
    const { task, run } = await start(c);
    await projectApprovalRequested(ctx.db, run.id, {
      approvalId: randomUUID(),
      callId: "call-1",
      tool: "shell",
      args: {},
      level: "write_reversible",
      summary: "Rodar um comando",
      secrets: [],
      source: "default",
    });
    const [card] = await listApprovals(ctx.db, {
      conversationId: c.conversation.id,
      status: "pending",
      limit: 10,
    });
    expect(card).toMatchObject({ runId: run.id, conversationId: c.conversation.id });
    expect(
      await listApprovals(ctx.db, {
        conversationId: task.taskConversationId,
        status: "pending",
        limit: 10,
      }),
    ).toEqual([]);
    expect((await getApproval(ctx.db, (card as { id: string }).id))?.conversationId).toBe(
      c.conversation.id,
    );
  });

  it("an item posted to the chat run never reaches the task (the run of the chat is another run)", async () => {
    const c = await chat();
    const { run } = await start(c);
    await postInbox(ctx.db, c.run.id, { kind: "user_message", text: "só no chat" });
    expect(await peekInboxEntries(ctx.db, run.id)).toEqual([]);
  });
});
