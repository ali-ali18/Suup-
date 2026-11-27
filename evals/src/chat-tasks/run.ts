// Owns running the chat-or-task cases against a real model (KOD-68). Each case gets a new bot (so a
// conversation of its own, with no history), its folder on the machine, and one chat run of the
// real path: the gate, the prompt, the task tools, and the brake and the end-of-turn check when the
// configuration turns them on. Only the chat run is run: a task it opens stays queued, is counted,
// then cancelled, because what is measured is where the work went, not the work.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  archiveBot,
  cancelRun,
  createBot,
  createRule,
  createTask,
  getRun,
  listMessages,
  listRunEvents,
  listTasks,
  type RunEvent,
  setRunStatus,
} from "@suup/db";
import {
  finishRun,
  type Runtime,
  SEND_TO_TASK_TOOL,
  START_TASK_TOOL,
  sendMessage,
} from "@suup/runtime";
import {
  BASELINE,
  CHAT_TASK_CASES,
  CHAT_TASK_CATEGORIES,
  type ChatTaskCase,
  type ChatTaskCategory,
} from "./cases.js";

export type ChatTaskVariant = "a" | "b";

/** The tools the bots of the eval get: the machine and its files, nothing that leaves it. */
export const CHAT_TASK_BOT_TOOLS = [
  "shell",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
] as const;

const OPEN = new Set(["queued", "running", "waiting_user", "waiting_approval", "waiting_timer"]);

export interface ChatTaskResult {
  id: string;
  category: ChatTaskCategory;
  passed: boolean;
  /** Why it failed, in Portuguese (empty when it passed). */
  why: string;
  status: string;
  /** Tasks this chat run opened, by the bot or by the brake. */
  tasks: number;
  expectedTasks: number;
  /** Tasks the bot opened itself with the tool. */
  byBot: number;
  /** The brake moved the work (variant B). */
  byBrake: boolean;
  /** Tool calls in the chat before the first task opened (`null`: none opened). */
  stepsBeforeTask: number | null;
  /** Follow-ups: the message was passed on to the open task. */
  forwarded: boolean | null;
  /** End-of-turn check: asks it found left out (variant B). `null`: it did not run. */
  unhandledAsks: string[] | null;
  turns: number;
  toolCalls: number;
  /** The run hit the eval's own limit and was cancelled (counts as work kept in the chat). */
  capped: boolean;
  /** From the user's message to the bot's first message in the chat. */
  firstReplyMs: number | null;
  /** From the user's message to the end of the chat run. */
  endMs: number | null;
  costUsd: number;
}

export interface ChatTaskCategorySummary {
  category: ChatTaskCategory;
  passed: number;
  total: number;
  baseline: { passed: number; total: number } | null;
  failedIds: string[];
}

export interface ChatTaskReport {
  variant: ChatTaskVariant;
  model: string;
  results: ChatTaskResult[];
  categories: ChatTaskCategorySummary[];
  totalCostUsd: number;
  /** Cases left out because the budget ran out. */
  notRun: string[];
}

export interface RunChatTasksOptions {
  /** A runtime whose configuration is the variant's (`defaults.tasks`). */
  runtime: Runtime;
  variant: ChatTaskVariant;
  /** The model of the bots, from the configuration. */
  modelId: string;
  /** The root of the local machine, where each case's folder is written. */
  machineRoot: string;
  /** The cases' folders go under this path, relative to the machine's root. */
  folder: string;
  cases?: readonly ChatTaskCase[];
  /** Stop before a case when the money spent so far reaches this (US$). */
  budgetUsd?: number;
  /** A chat run past this many model calls is cancelled (default 14). */
  maxTurns?: number;
  /** A chat run past this many seconds is cancelled (default 240). */
  maxSeconds?: number;
  onCase?(result: ChatTaskResult, spentUsd: number): void;
}

const at = (text: string, dir: string) => text.replaceAll("{dir}", dir);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
}

/** The chat run, to its end or to the eval's limit. */
function follow(
  runtime: Runtime,
  runId: string,
  limits: { maxTurns: number; maxSeconds: number },
): Promise<{ status: string; capped: boolean }> {
  return new Promise((resolve, reject) => {
    let capped = false;
    const startedAt = Date.now();
    const watch = setInterval(() => {
      void (async () => {
        if (capped) return;
        const run = await getRun(runtime.db, runId);
        if (run === null || !OPEN.has(run.status)) return;
        if (run.turns >= limits.maxTurns || Date.now() - startedAt >= limits.maxSeconds * 1000) {
          capped = true;
          await cancelRun(runtime.db, runId).catch(() => undefined);
        }
      })();
    }, 500);
    const worker = runtime.createWorker({
      onlyRunId: runId,
      idleBackoff: { minMs: 50, maxMs: 500 },
      reception: false,
      onRunEnd: (end) => {
        clearInterval(watch);
        void worker.stop();
        resolve({ status: end.outcome === "settled" ? end.status : end.outcome, capped });
      },
      onError: (error) => {
        clearInterval(watch);
        void worker.stop();
        reject(error);
      },
    });
    worker.start();
  });
}

function argsOf(event: RunEvent): Record<string, unknown> {
  const args = (event.payload as { args?: unknown }).args;
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

/** Runs one case and scores it. */
async function runCase(
  options: RunChatTasksOptions,
  c: ChatTaskCase,
  limits: { maxTurns: number; maxSeconds: number },
): Promise<ChatTaskResult> {
  const { runtime } = options;
  const db = runtime.db;
  const { model } = runtime.resolveModel(options.modelId);
  const dir = `${options.folder}/${c.id}`;
  if (c.files !== undefined) await writeFiles(join(options.machineRoot, dir), c.files);

  const bot = await createBot(db, {
    name: `Eval ${options.variant.toUpperCase()} ${c.id}`.slice(0, 60),
    modelProvider: model.provider,
    modelId: model.id,
    allowedTools: [...CHAT_TASK_BOT_TOOLS],
  });
  // The eval measures where the work goes, not the approvals: the bot's own tools run without a card.
  for (const tool of CHAT_TASK_BOT_TOOLS)
    await createRule(db, { botId: bot.id, tool, effect: "allow" });

  let openTaskId: string | null = null;
  let conversationId: string;
  let sent: Awaited<ReturnType<typeof sendMessage>>;
  try {
    if (c.before !== undefined) {
      // The task already open: asked in an earlier turn that ended with its short answer.
      const first = await sendMessage(runtime, { botId: bot.id, text: at(c.before.message, dir) });
      const { task } = await createTask(db, {
        fromRunId: first.run.id,
        title: c.before.title,
        brief: at(c.before.brief, dir),
        sourceMessageIds: [first.message.id],
      });
      openTaskId = task.id;
      await setRunStatus(db, first.run.id, { from: "queued", to: "running" });
      await setRunStatus(db, first.run.id, {
        from: "running",
        to: "done",
        result: { summary: c.before.answer },
      });
      await finishRun(db, first.run.id);
      sent = await sendMessage(runtime, {
        conversationId: first.message.conversationId,
        text: at(c.message, dir),
      });
    } else {
      sent = await sendMessage(runtime, { botId: bot.id, text: at(c.message, dir) });
    }
    conversationId = sent.message.conversationId;
    const runId = sent.run.id;
    const followed = await follow(runtime, runId, limits);
    // A run parked on a card or a question has done what it will do in this turn.
    const run = await getRun(db, runId);
    if (run !== null && OPEN.has(run.status)) await cancelRun(db, runId).catch(() => undefined);

    const events = await listRunEvents(db, runId, { limit: 2000 });
    const calls = events.filter((e) => e.type === "tool_call");
    const results = new Map(
      events
        .filter((e) => e.type === "tool_result")
        .map((e) => [(e.payload as { callId: string }).callId, e.payload as { isError: boolean }]),
    );
    const okCall = (e: RunEvent) =>
      results.get((e.payload as { callId: string }).callId)?.isError === false;
    const startCalls = calls.filter(
      (e) => (e.payload as { name: string }).name === START_TASK_TOOL && okCall(e),
    );
    const handed = events.find(
      (e) => e.type === "handed_off" && (e.payload as { outcome: string }).outcome === "started",
    );
    const firstTaskSeq = Math.min(
      startCalls[0]?.seq ?? Number.POSITIVE_INFINITY,
      handed?.seq ?? Number.POSITIVE_INFINITY,
    );
    const tasks = (await listTasks(db, { conversationId })).filter((t) => t.fromRunId === runId);
    const forwarded =
      openTaskId === null
        ? null
        : calls.some(
            (e) =>
              (e.payload as { name: string }).name === SEND_TO_TASK_TOOL &&
              argsOf(e).taskId === openTaskId &&
              okCall(e),
          );
    const checked = events.find((e) => e.type === "asks_checked");
    const unhandledAsks =
      checked === undefined ? null : ((checked.payload as { unhandled: string[] }).unhandled ?? []);

    const messages = await listMessages(db, conversationId, { limit: 200 });
    const firstReply = messages.find((m) => m.seq > sent.message.seq && m.authorKind !== "user");
    const ended = await getRun(db, runId);
    const sentAt = sent.message.createdAt.getTime();

    const capped = followed.capped;
    const expectedTasks = c.expect.tasks;
    const problems: string[] = [];
    if (capped) problems.push("passou do limite no chat e foi cancelada");
    if (tasks.length !== expectedTasks) {
      problems.push(`abriu ${tasks.length} tarefa(s), esperado ${expectedTasks}`);
    }
    if (c.expect.forward !== undefined && forwarded !== c.expect.forward) {
      problems.push(
        c.expect.forward ? "não repassou à tarefa aberta" : "repassou à tarefa sem motivo",
      );
    }
    if (!capped && followed.status !== "done" && followed.status !== "waiting_user") {
      problems.push(`terminou como ${followed.status}`);
    }

    return {
      id: c.id,
      category: c.category,
      passed: problems.length === 0,
      why: problems.join("; "),
      status: followed.status,
      tasks: tasks.length,
      expectedTasks,
      byBot: startCalls.length,
      byBrake: handed !== undefined,
      stepsBeforeTask: Number.isFinite(firstTaskSeq)
        ? calls.filter(
            (e) => e.seq < firstTaskSeq && (e.payload as { name: string }).name !== START_TASK_TOOL,
          ).length
        : null,
      forwarded,
      unhandledAsks,
      turns: ended?.turns ?? 0,
      toolCalls: calls.length,
      capped,
      firstReplyMs: firstReply === undefined ? null : firstReply.createdAt.getTime() - sentAt,
      endMs: ended?.finishedAt == null ? null : ended.finishedAt.getTime() - sentAt,
      costUsd: Number(ended?.costUsd ?? 0),
    };
  } finally {
    // Nothing of the eval keeps running: every task it opened ends here, and the bot is put away.
    const left = await listTasks(db, { botId: bot.id });
    for (const task of left) {
      const taskRun = await getRun(db, task.runId);
      if (taskRun !== null && OPEN.has(taskRun.status)) {
        await cancelRun(db, task.runId).catch(() => undefined);
      }
    }
    await archiveBot(db, bot.id);
  }
}

export async function runChatTasks(options: RunChatTasksOptions): Promise<ChatTaskReport> {
  const cases = options.cases ?? CHAT_TASK_CASES;
  const limits = { maxTurns: options.maxTurns ?? 14, maxSeconds: options.maxSeconds ?? 240 };
  const results: ChatTaskResult[] = [];
  const notRun: string[] = [];
  let spent = 0;
  for (const c of cases) {
    if (options.budgetUsd !== undefined && spent >= options.budgetUsd) {
      notRun.push(c.id);
      continue;
    }
    const result = await runCase(options, c, limits);
    spent += result.costUsd;
    results.push(result);
    options.onCase?.(result, spent);
  }
  return {
    variant: options.variant,
    model: options.modelId,
    results,
    categories: CHAT_TASK_CATEGORIES.map((category) => {
      const own = results.filter((r) => r.category === category);
      return {
        category,
        passed: own.filter((r) => r.passed).length,
        total: own.length,
        baseline: BASELINE[category],
        failedIds: own.filter((r) => !r.passed).map((r) => r.id),
      };
    }),
    totalCostUsd: spent,
    notRun,
  };
}
