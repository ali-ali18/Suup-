import { join } from "node:path";
import {
  cancelRun,
  createBot,
  createDirectConversation,
  getRun,
  getTask,
  getTaskByRun,
  listMessages,
  listTasks,
  MAX_OPEN_TASKS,
  replyToTask,
  setRunStatus,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  finishRun,
  loadRunContext,
  parseConfig,
  type Runtime,
  reconcileRunEffects,
  sendMessage,
  sendToTaskTool,
  startTaskTool,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const SCRIPT = {
  cases: [
    // The closing turn of the chat: it sees the report of the task, wrapped as data.
    {
      whenObjectiveContains: "Report of the task",
      // The chat's earlier answer counts as a turn of the conversation (see the scripted provider).
      agent: [
        { text: "A auditoria terminou: três achados, o principal é o módulo de login." },
        { text: "A auditoria terminou: três achados, o principal é o módulo de login." },
      ],
    },
    // The task itself, chosen by a word only its brief has.
    {
      whenObjectiveContains: "TAREFA-AUDIT",
      agent: [{ text: "Auditoria do módulo X: três achados; o principal está no login." }],
    },
    {
      whenObjectiveContains: "Faça a auditoria",
      agent: [{ text: "Certo." }],
    },
  ],
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("tasks of a bot, end to end (KOD-68)"), () => {
  const ctx = useIsolatedDb();

  async function open() {
    await ctx.db
      .sql`update bots set archived_at = now(), is_default = false where archived_at is null`;
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), SCRIPT);
    const runtime = createRuntime(parseConfig(rawConfig({})), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    const bot = await createBot(runtime.db, {
      name: `Ajudante${Math.random().toString(36).slice(2, 7)}`,
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["shell", "write_file", "read_file"],
    });
    const sent = await sendMessage(runtime, {
      botId: bot.id,
      text: "Faça a auditoria do módulo X. Use só a pasta src.",
    });
    return { runtime, bot, sent };
  }

  const work = (runtime: Runtime, runId: string): Promise<string> =>
    new Promise((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: runId,
        idleBackoff: { minMs: 5, maxMs: 20 },
        onRunEnd: (end) => {
          resolve(end.outcome === "settled" ? end.status : end.outcome);
          void worker.stop();
        },
      });
      worker.start();
    });

  const toolCtx = (_runtime: Runtime, runId: string, botId: string) =>
    ({ runId, botId, executor: undefined, signal: new AbortController().signal }) as never;

  const brief = {
    title: "Auditar o módulo X",
    objective: "TAREFA-AUDIT: auditar o módulo X e listar os achados.",
    deliver: "Uma lista curta de achados, o mais grave primeiro.",
    userMessageIds: [] as string[],
  };

  const chatTexts = async (runtime: Runtime, conversationId: string) =>
    (await listMessages(runtime.db, conversationId, { limit: 100 }))
      .filter((m) => m.authorKind !== "user")
      .map((m) => m.text);

  it("opens a task that runs on its own while the chat stays free, then reports to the chat once", async () => {
    const { runtime, bot, sent } = await open();
    const chatId = sent.message.conversationId;
    const started = await startTaskTool(runtime.db).execute(
      { ...brief, userMessageIds: [sent.message.id] },
      toolCtx(runtime, sent.run.id, bot.id),
    );
    expect(started.isError).toBeUndefined();
    expect(started.content).toContain("Do not wait");
    const [task] = await listTasks(runtime.db, { botId: bot.id });
    expect(task).toBeDefined();
    const taskRun = await getRun(runtime.db, task?.runId as string);
    expect(taskRun).toMatchObject({ origin: "task", status: "queued", botId: bot.id });
    // The brief the run starts from is what the tool composed, in a fixed order.
    expect(taskRun?.objective).toContain("Objective: TAREFA-AUDIT");
    expect(taskRun?.objective).toContain("Return: Uma lista curta de achados");

    // The chat is free: its own run answers while the task has not started.
    expect(await work(runtime, sent.run.id)).toBe("done");
    expect(await chatTexts(runtime, chatId)).toEqual(["Certo."]);
    expect((await getRun(runtime.db, taskRun?.id as string))?.status).toBe("queued");

    // The task works, in its own conversation; the chat does not see its messages.
    expect(await work(runtime, taskRun?.id as string)).toBe("done");
    const taskMessages = await chatTexts(runtime, task?.taskConversationId as string);
    expect(taskMessages).toContain(
      "Auditoria do módulo X: três achados; o principal está no login.",
    );
    expect(await chatTexts(runtime, chatId)).toEqual(["Certo."]);

    // The end opened the closing turn in the chat: the chat's foreground run, with the report as data.
    const closed = await getTask(runtime.db, task?.id as string);
    expect(closed?.closedAt).not.toBeNull();
    const closing = await getRun(runtime.db, closed?.closingRunId as string);
    expect(closing).toMatchObject({
      origin: "task_result",
      conversationId: chatId,
      status: "queued",
    });
    expect(closing?.objective).toContain('Report of the task "Auditar o módulo X"');
    expect(closing?.objective).toContain("not a message from the user");
    expect(closing?.objective).toContain("<<<EXTERNAL_DATA");
    expect(closing?.objective).toContain("três achados; o principal está no login");
    expect(await work(runtime, closing?.id as string)).toBe("done");
    expect(await chatTexts(runtime, chatId)).toEqual([
      "Certo.",
      "A auditoria terminou: três achados, o principal é o módulo de login.",
    ]);
    // Idempotent: finishing again and reconciling open nothing else.
    await finishRun(runtime.db, taskRun?.id as string);
    await reconcileRunEffects(runtime.db);
    await reconcileRunEffects(runtime.db);
    expect(
      (
        await runtime.db.sql<{ n: number }[]>`
        select count(*)::int as n from runs where origin = 'task_result' and conversation_id = ${chatId}`
      )[0]?.n,
    ).toBe(1);
    await runtime.close();
  });

  it("starts a task from exactly the brief and the cited user messages, copied from the database", async () => {
    const { runtime, bot, sent } = await open();
    const other = await sendMessage(runtime, {
      botId: (
        await createBot(runtime.db, {
          name: `Outro${Math.random().toString(36).slice(2, 7)}`,
          modelProvider: "script",
          modelId: "model-s",
        })
      ).id,
      text: "Mensagem de outro chat",
    });
    const tool = startTaskTool(runtime.db);
    // A foreign id, and an id that is not even a message, are refused with a sentence that says not to retry.
    const foreign = await tool.execute(
      { ...brief, userMessageIds: [other.message.id] },
      toolCtx(runtime, sent.run.id, bot.id),
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toContain("Not started");
    await tool.execute(
      { ...brief, userMessageIds: [sent.message.id] },
      toolCtx(runtime, sent.run.id, bot.id),
    );
    const task = (await listTasks(runtime.db, { botId: bot.id }))[0];
    const context = await loadRunContext(runtime.db, task?.runId as string);
    // No history; the user's words exactly as stored; the chat's other messages are nowhere.
    expect(context.history).toEqual([]);
    expect(context.task).toEqual({
      title: "Auditar o módulo X",
      userMessages: ["Faça a auditoria do módulo X. Use só a pasta src."],
    });
    expect(JSON.stringify(context)).not.toContain("Mensagem de outro chat");
    // The chat run is told the ids of the user's latest messages, to cite them.
    const chatContext = await loadRunContext(runtime.db, sent.run.id);
    expect(chatContext.recentUserMessages).toEqual([
      { id: sent.message.id, text: "Faça a auditoria do módulo X. Use só a pasta src." },
    ]);
    await runtime.close();
  });

  it("refuses a fourth open task and a task from a task, and does not offer the tools to a task", async () => {
    const { runtime, bot, sent } = await open();
    const tool = startTaskTool(runtime.db);
    for (let i = 1; i <= MAX_OPEN_TASKS; i++) {
      const out = await tool.execute(
        { ...brief, title: `Auditoria ${i}` },
        toolCtx(runtime, sent.run.id, bot.id),
      );
      expect(out.isError).toBeUndefined();
    }
    const fourth = await tool.execute(
      { ...brief, title: "Auditoria 4" },
      toolCtx(runtime, sent.run.id, bot.id),
    );
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain("Do not retry");
    const [first] = await listTasks(runtime.db, { botId: bot.id });
    // The chat run is offered both tools; a task run is offered neither, and the code refuses anyway.
    expect((await runtime.buildDeps(sent.run.id, "w")).bot.allowedTools).toEqual(
      expect.arrayContaining(["start_task", "send_to_task"]),
    );
    const taskDeps = await runtime.buildDeps(first?.runId as string, "w");
    expect(taskDeps.bot.allowedTools).not.toContain("start_task");
    expect(taskDeps.bot.allowedTools).not.toContain("send_to_task");
    const nested = await tool.execute(
      { ...brief, title: "De dentro" },
      toolCtx(runtime, first?.runId as string, bot.id),
    );
    expect(nested.isError).toBe(true);
    expect(nested.content).toContain("cannot open another task");
    await runtime.close();
  });

  it("waits to report while the chat is busy, and opens the closing turn when the chat run ends", async () => {
    const { runtime, bot, sent } = await open();
    const chatId = sent.message.conversationId;
    await startTaskTool(runtime.db).execute(brief, toolCtx(runtime, sent.run.id, bot.id));
    const task = (await listTasks(runtime.db, { botId: bot.id }))[0];
    // The task ends while the chat run has not even been taken: the chat is busy.
    expect(await work(runtime, task?.runId as string)).toBe("done");
    expect((await getTask(runtime.db, task?.id as string))?.closedAt).toBeNull();
    // The chat run ends (the worker writes its effects): the chat is free and takes the report.
    expect(await work(runtime, sent.run.id)).toBe("done");
    const closed = await getTask(runtime.db, task?.id as string);
    expect(closed?.closingRunId).not.toBeNull();
    expect((await getRun(runtime.db, closed?.closingRunId as string))?.origin).toBe("task_result");
    expect(await work(runtime, closed?.closingRunId as string)).toBe("done");
    expect((await chatTexts(runtime, chatId)).at(-1)).toContain("A auditoria terminou");
    await runtime.close();
  });

  it("recovers a result a worker never delivered (it died after the task ended), once", async () => {
    const { runtime, bot, sent } = await open();
    await work(runtime, sent.run.id);
    await startTaskTool(runtime.db).execute(brief, toolCtx(runtime, sent.run.id, bot.id));
    const task = (await listTasks(runtime.db, { botId: bot.id }))[0];
    // The worker dies right after the task is done: no effect ran.
    await setRunStatus(runtime.db, task?.runId as string, { from: "queued", to: "running" });
    await setRunStatus(
      runtime.db,
      task?.runId as string,
      {
        from: "running",
        to: "done",
        result: { summary: "Relatório da tarefa." },
      } as never,
    );
    expect((await getTask(runtime.db, task?.id as string))?.closedAt).toBeNull();
    await reconcileRunEffects(runtime.db);
    await reconcileRunEffects(runtime.db);
    const closed = await getTask(runtime.db, task?.id as string);
    const closing = await getRun(runtime.db, closed?.closingRunId as string);
    expect(closing?.objective).toContain("Relatório da tarefa.");
    expect(
      (
        await runtime.db.sql<{ n: number }[]>`
        select count(*)::int as n from runs
        where origin = 'task_result' and parent_run_id = ${task?.runId as string}`
      )[0]?.n,
    ).toBe(1);
    await runtime.close();
  });

  it("a stopped task reports nothing to the chat and leaves it as it was", async () => {
    const { runtime, bot, sent } = await open();
    await work(runtime, sent.run.id);
    await startTaskTool(runtime.db).execute(brief, toolCtx(runtime, sent.run.id, bot.id));
    const task = (await listTasks(runtime.db, { botId: bot.id }))[0];
    await cancelRun(runtime.db, task?.runId as string);
    await finishRun(runtime.db, task?.runId as string);
    const closed = await getTask(runtime.db, task?.id as string);
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.closingRunId).toBeNull();
    expect(await chatTexts(runtime, sent.message.conversationId)).toEqual(["Certo."]);
    await runtime.close();
  });

  it("send_to_task passes the user's own message by id, and refuses a task of another chat", async () => {
    const { runtime, bot, sent } = await open();
    await startTaskTool(runtime.db).execute(brief, toolCtx(runtime, sent.run.id, bot.id));
    const task = (await listTasks(runtime.db, { botId: bot.id }))[0];
    const second = await sendMessage(runtime, {
      conversationId: sent.message.conversationId,
      text: "Pode incluir os testes também.",
    });
    const out = await sendToTaskTool(runtime.db).execute(
      { taskId: task?.id as string, messageId: second.message.id },
      toolCtx(runtime, second.run.id, bot.id),
    );
    expect(out.isError).toBeUndefined();
    const inbox = await runtime.db.sql<{ text: string }[]>`
      select text from run_inbox where run_id = ${task?.runId as string} and consumed_at is null`;
    expect(inbox.map((i) => i.text)).toEqual(["Pode incluir os testes também."]);
    // A reply in the task view goes to the same inbox, through the task id.
    await replyToTask(runtime.db, task?.id as string, "Obrigado.");
    expect(
      (
        await runtime.db.sql<{ text: string }[]>`
          select text from run_inbox where run_id = ${task?.runId as string} order by id`
      ).map((i) => i.text),
    ).toEqual(["Pode incluir os testes também.", "Obrigado."]);
    // The task of another bot's chat is not reachable from this one.
    const stranger = await createBot(runtime.db, {
      name: `Estranho${Math.random().toString(36).slice(2, 7)}`,
      modelProvider: "script",
      modelId: "model-s",
    });
    const strangerConv = await createDirectConversation(runtime.db, stranger.id);
    const strangerRun = await sendMessage(runtime, {
      conversationId: strangerConv.id,
      text: "Oi",
    });
    const refused = await sendToTaskTool(runtime.db).execute(
      { taskId: task?.id as string, text: "x" },
      toolCtx(runtime, strangerRun.run.id, stranger.id),
    );
    expect(refused.isError).toBe(true);
    expect(await getTaskByRun(runtime.db, task?.runId as string)).not.toBeNull();
    await runtime.close();
  });
});
