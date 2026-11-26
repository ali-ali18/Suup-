// Tasks of a bot (KOD-68, docs/TAREFAS.md): the two tools of the chat run (`start_task`,
// `send_to_task`) and the way a finished task's result comes back to the chat as a short turn.
//
// A task is a run of the same bot with the origin `task`, in a conversation of its own. The rules
// that matter are enforced in `@suup/db` (the limit of three, no task from a task, the cited
// messages being the user's own); here the model is only told the criteria and what happened.
import { defineTool, runResultSchema, wrapUntrusted } from "@suup/core";
import {
  closeTaskWithoutResult,
  createTask,
  type Db,
  forwardToTask,
  getRun,
  getTaskByRun,
  MAX_OPEN_TASKS,
  MAX_TASK_SOURCE_MESSAGES,
  openTaskResult,
  pendingTaskResults,
  type Run,
  type Task,
  TaskError,
} from "@suup/db";
import { z } from "zod";

export const START_TASK_TOOL = "start_task";
export const SEND_TO_TASK_TOOL = "send_to_task";
export const TASK_TOOL_NAMES = [START_TASK_TOOL, SEND_TO_TASK_TOOL] as const;

/** Longest report handed to the chat turn (the full report stays in the task). */
const REPORT_MAX_CHARS = 8000;

const clip = (text: string, max: number): string => {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const startTaskInput = z.object({
  title: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .describe(
      "A short name the user sees in the chat, in their language (for example 'Revisar o projeto').",
    ),
  objective: z
    .string()
    .trim()
    .min(10)
    .max(1500)
    .describe("What the task must achieve, in one clear paragraph."),
  known: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .describe(
      "What is already known that the task cannot find out alone: names, paths, dates, constraints, what you tried.",
    ),
  deliver: z
    .string()
    .trim()
    .min(3)
    .max(600)
    .describe("What the task must return when it ends (the shape of its report)."),
  scope: z
    .string()
    .trim()
    .max(600)
    .optional()
    .describe(
      "How far to go: what it may do, what it must not do, where to stop and ask the user.",
    ),
  userMessageIds: z
    .array(z.uuid())
    .max(MAX_TASK_SOURCE_MESSAGES)
    .default([])
    .describe(
      "Ids of the user's messages (from 'The user's latest messages') that carry the request; copied to the task exactly.",
    ),
});

/** The brief a task starts from: the model's fields, in a fixed order, as plain text. */
export function composeBrief(input: {
  objective: string;
  known?: string | undefined;
  deliver: string;
  scope?: string | undefined;
}): string {
  const lines = [`Objective: ${input.objective}`];
  if (input.known !== undefined && input.known !== "") lines.push(`Already known: ${input.known}`);
  lines.push(`Return: ${input.deliver}`);
  if (input.scope !== undefined && input.scope !== "") lines.push(`How far to go: ${input.scope}`);
  return lines.join("\n\n");
}

/**
 * `start_task`: hands long work to a task of the same bot, which runs in the background while the
 * chat stays free. Only a chat run of the user is offered it (never a task, never the closing turn).
 * It returns at once.
 */
export function startTaskTool(db: Db) {
  return defineTool({
    name: START_TASK_TOOL,
    description: `Opens a TASK: a background run of yourself, in its own view, for LONG work, while this chat stays free. Answer in the chat, with no task, when the request is quick: a question, a summary, a short draft, a lookup. Open a task when the work is long: implement or change code, review a project, research a subject across many sources, browse a site, anything of many steps or minutes (when in doubt and it will take more than a couple of minutes, open one).

The task does NOT see this conversation: it gets only your brief (objective, what is known, what to return, how far to go) and the user's messages you cite in \`userMessageIds\`, copied exactly. It returns at once; tell the user, do not wait or poll. At most ${MAX_OPEN_TASKS} tasks are open at once and a task cannot open another; if a call is refused, do not retry it: tell the user.`,
    input: startTaskInput,
    risk: "write_reversible",
    ownOutput: true,
    timeoutMs: 30_000,
    async execute(input, ctx) {
      try {
        const out = await createTask(db, {
          fromRunId: ctx.runId,
          title: input.title,
          brief: composeBrief(input),
          sourceMessageIds: input.userMessageIds,
        });
        return {
          content: out.created
            ? `Task "${out.task.title}" started (id ${out.task.id}). It works in the background as you, in its own view; its report will come back to this chat when it ends. Tell the user you opened it, in a line or two, and carry on with the chat. Do not wait for it and do not poll.`
            : `The task "${out.task.title}" was already started in this run (id ${out.task.id}); nothing new was started.`,
        };
      } catch (error) {
        if (error instanceof TaskError) {
          const advice: Record<TaskError["code"], string> = {
            limit: `You already have ${MAX_OPEN_TASKS} tasks open. Do not retry: tell the user to wait for one to finish, or to stop one.`,
            nested: "A task cannot open another task. Do not retry: do the work yourself.",
            not_chat: "Only a chat with the user opens a task. Do not retry.",
            invalid_messages:
              "Cite only ids from 'The user's latest messages'. Do not invent ids: fix the list (or leave it empty) and call again.",
            archived: "Do not retry.",
            not_found: "Do not retry.",
            finished: "Do not retry.",
            wrong_chat: "Do not retry.",
          };
          return { isError: true, content: `Not started: ${error.message} ${advice[error.code]}` };
        }
        throw error;
      }
    },
  });
}

const sendToTaskInput = z
  .object({
    taskId: z.uuid().describe("The id of the task (it came back from `start_task`)."),
    messageId: z
      .uuid()
      .optional()
      .describe(
        "The id of a message of the user (from 'The user's latest messages') to pass on exactly as they wrote it. Prefer this whenever what you pass on is the user's own words.",
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe(
        "Your own words, only when there is no user message to cite (a summary of what changed). The task is told they are yours, not the user's.",
      ),
  })
  .refine((v) => (v.messageId === undefined) !== (v.text === undefined), {
    message: "give exactly one of messageId and text",
  });

/**
 * `send_to_task`: passes something the user said in the chat on to a task that is running. It is
 * delivered at the task's next safe point; the user's own words go by message id, copied from the
 * database. Only a task asked in this chat.
 */
export function sendToTaskTool(db: Db) {
  return defineTool({
    name: SEND_TO_TASK_TOOL,
    description:
      "Passes on to a running task something the user said in this chat about it: a change, an extra detail, or a request to stop it. Cite the user's message by `messageId` when you can (it reaches the task exactly as they wrote it); use `text` only for your own words. The task reads it at its next safe point. Say to the user that you passed it on; do not wait for the task. A task that already ended takes nothing: tell the user.",
    input: sendToTaskInput,
    risk: "write_reversible",
    ownOutput: true,
    timeoutMs: 30_000,
    async execute(input, ctx) {
      const run = await getRun(db, ctx.runId);
      if (run === null || run.conversationId === null || run.conversationId === undefined) {
        return { isError: true, content: "Not sent: this run has no chat." };
      }
      try {
        const out = await forwardToTask(db, {
          taskId: input.taskId,
          fromConversationId: run.conversationId,
          ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          ...(input.text === undefined ? {} : { text: input.text }),
        });
        return {
          content: `Passed on to the task "${out.task.title}": it will read it at its next safe point. Tell the user you did, and carry on.`,
        };
      } catch (error) {
        if (error instanceof TaskError) {
          return {
            isError: true,
            content: `Not sent: ${error.message}${error.code === "finished" ? " Its report is (or will be) in this chat: tell the user." : ""}`,
          };
        }
        throw error;
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The result comes back

/** The report of an ended task, as text for the chat turn (the model's own summary, or the failure). */
function reportOf(run: Run, failure: string): string {
  const parsed = runResultSchema.safeParse(run.result);
  const summary = parsed.success ? parsed.data.summary.trim() : "";
  if (run.status === "done")
    return summary === "" ? "(The task ended without a written report.)" : summary;
  if (run.status === "failed") {
    return `The task did not finish. ${failure}${summary === "" ? "" : `\n\n${summary}`}`;
  }
  return "The task was stopped before it finished.";
}

/**
 * The objective of the chat turn that receives a task's report: a note that says what this is, then
 * the report as external data (it is text a model wrote, with no authority over the chat bot).
 */
export function taskResultObjective(task: Task, run: Run, failure: string): string {
  const how =
    run.status === "done" ? "finished" : run.status === "failed" ? "did not finish" : "was stopped";
  return `[Report of the task ${JSON.stringify(task.title)}, which ${how}. This is not a message from the user. Tell the user about it in a few short lines.]\n\n${wrapUntrusted(
    `task:${task.title}`,
    clip(reportOf(run, failure), REPORT_MAX_CHARS),
  )}`;
}

/**
 * Hands one finished task's result to its chat, once: a short turn of the bot that asked for it.
 * A task the user stopped delivers nothing (the app already shows "Parada"). When the chat has a run
 * working or waiting, nothing is opened now: the result waits and `deliverPendingTaskResults` opens
 * it when the chat is free. Idempotent (the task row says it was closed), also after a crash.
 * Returns the turn it opened, if any.
 */
export async function deliverTaskResult(
  db: Db,
  run: Run,
  failureText: (run: Run) => string,
): Promise<Run | null> {
  if (run.origin !== "task") return null;
  if (run.status !== "done" && run.status !== "failed" && run.status !== "cancelled") return null;
  const task = await getTaskByRun(db, run.id);
  if (task === null || task.closedAt !== null) return null;
  if (run.status === "cancelled") {
    await closeTaskWithoutResult(db, task.id);
    return null;
  }
  const result = await openTaskResult(
    db,
    task.id,
    taskResultObjective(task, run, failureText(run)),
  );
  return result.state === "opened" ? result.run : null;
}

/**
 * Opens the result of every finished task of a chat that is waiting for it (the chat was busy when
 * the task ended), or of all chats (the crash recovery). Opens at most one turn per chat: the next
 * waits for that one to end.
 */
export async function deliverPendingTaskResults(
  db: Db,
  failureText: (run: Run) => string,
  options: { conversationId?: string } = {},
): Promise<Run[]> {
  const opened: Run[] = [];
  const pending = await pendingTaskResults(db, options);
  for (const { run } of pending) {
    const turn = await deliverTaskResult(db, run, failureText);
    if (turn !== null) opened.push(turn);
  }
  return opened;
}
