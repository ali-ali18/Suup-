// Tasks of a bot (KOD-68, docs/TAREFAS.md): the two tools of the chat run (`start_task`,
// `send_to_task`) and the way a finished task's result comes back to the chat as a short turn.
//
// A task is a run of the same bot with the origin `task`, in a conversation of its own. The rules
// that matter are enforced in `@suup/db` (the limit of three, no task from a task, the cited
// messages being the user's own); here the model is only told the criteria and what happened.
import {
  defineTool,
  type HandoffOutcome,
  type HandoffRequest,
  type OpenTaskFact,
  runResultSchema,
  wrapUntrusted,
} from "@suup/core";
import {
  closeTaskWithoutResult,
  createTask,
  type Db,
  forwardToTask,
  getRun,
  getTaskByRun,
  listTasks,
  MAX_OPEN_TASKS,
  MAX_TASK_SOURCE_MESSAGES,
  openTaskResult,
  pendingTaskResults,
  type Run,
  type Task,
  TaskError,
  userMessagesOfRun,
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
    description: `Opens a TASK: a background run of yourself, in its own view, for LONG work, while this chat stays free.

Decide BEFORE your first tool call, by the effort the request needs:
- More than about 5 tool calls, or more than about a minute of work: open a task, as your FIRST call. Do not start the work here and move it later; every call you make here first is repeated or wasted.
- Up to about 5 calls and well under a minute: answer here, with no task.

Having a terminal, files or a browser here is NO reason to do long work in the chat: the task has the same tools as you. Running tests, editing several files, installing and building, reading a whole folder, researching across several pages: all of that is a task.

Open a task for self-contained work that ends in a result you can hand back: researching a subject across several sources, reviewing a whole folder or a long document, implementing something with several files and tests, analysing a dataset in depth, browsing several pages of a site, writing a document with several sections.

Stay in the chat for quick requests: a question, a lookup, a summary of one thing, a short draft, one small change, one command and its output. Also stay in the chat when the work needs the user's back-and-forth at every step: a task works alone and asks only when it is stuck.

One message, several requests: handle EACH one. Open one task per long request (two long requests are two tasks) and answer each quick one here, in the same turn. Before you end the turn, check that every request in the message was either answered or handed to a task; never answer only the first one, and never promise to do one later without opening its task.

Examples.
- "compare these five frameworks and write me a recommendation with sources" → task.
- "run the test suite, fix what fails and tell me" → task (many terminal calls), even though you have a terminal.
- "review every file in src/ and list the problems" → task.
- "what does this error mean?" / "rename this file" / "what time is it in Tokyo?" → chat.
- "what is 15% of 230, and write me a full market analysis of electric bikes in Brazil" → answer the percentage here AND open one task for the analysis.
- "research flights to Lisbon and also review my CV in cv.md" → two tasks, one each.

If the work needs a tool you do not have, open the task only if the task itself could do it with what you have; otherwise tell the user what is missing.

The task does NOT see this conversation: it gets only your brief (objective, what is known, what to return, how far to go) and the user's messages you cite in \`userMessageIds\`, copied exactly. Before opening one, check "The tasks of this chat": if one of them already covers the work, pass the new detail to it with \`send_to_task\` instead of opening a duplicate. It returns at once; tell the user, do not wait, poll or schedule a return to check on it: its report comes back by itself. At most ${MAX_OPEN_TASKS} tasks are open at once and a task cannot open another; if a call is refused, do not retry it: tell the user.`,
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

/** The longest trail line, and how many lines the brief carries. */
const TRAIL_LINE_MAX = 240;
const TRAIL_MAX_LINES = 20;

/** The task's name when the brake opens it: the first line of the user's message, clipped. */
export function handoffTitle(objective: string): string {
  const first = objective.trim().split("\n")[0]?.trim() ?? "";
  const title = clip(first, 60);
  return title.length >= 3 ? title : "Trabalho do chat";
}

/** The brief of a task the brake opened: the user's request stands, the done calls are listed. */
export function handoffBrief(request: HandoffRequest): string {
  const trail = request.trail
    .slice(-TRAIL_MAX_LINES)
    .map((e) => `- ${e.name} ${clip(e.args, TRAIL_LINE_MAX)}${e.isError ? " (failed)" : ""}`);
  return composeBrief({
    objective:
      "Do what the user asked in their message(s), attached below exactly. The chat started this work and moved it here because it is long work.",
    ...(trail.length === 0
      ? {}
      : {
          known: `The chat already made these calls, oldest first. Their results are not here: read again what you need, and do not repeat a write that already succeeded.\n${trail.join("\n")}`,
        }),
    deliver:
      "A short report for the chat: the result the user asked for, what you changed, and anything left for the user.",
    scope:
      "Do what the request asks and nothing more. Stop and ask the user only when you are stuck or a step needs their decision.",
  });
}

/**
 * The early brake's way to open the task (`LoopDeps.handoff.start`): the same `createTask` as
 * `start_task`, with the run's own user messages cited, so the task gets the user's exact words.
 */
export function handoffStarter(db: Db): (request: HandoffRequest) => Promise<HandoffOutcome> {
  return async (request) => {
    try {
      const sourceMessageIds = await userMessagesOfRun(db, request.run.id);
      const out = await createTask(db, {
        fromRunId: request.run.id,
        title: handoffTitle(request.run.objective),
        brief: handoffBrief(request),
        sourceMessageIds,
      });
      return { started: true, taskId: out.task.id, title: out.task.title };
    } catch (error) {
      // Refused (the limit of open tasks, an archived bot…): the chat run goes on as it was.
      if (error instanceof TaskError) return { started: false, reason: error.message };
      throw error;
    }
  };
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

// ---------------------------------------------------------------------------------------------
// What a chat run is told about the tasks of its chat

/** How long an ended task stays in the list the chat bot is shown, and the most that are listed. */
export const ENDED_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ENDED_TASKS_LISTED = 5;

/** Where a task is, from the state of its run (the same reading the API has). */
function taskStateOfRun(status: Run["status"]): OpenTaskFact["state"] {
  switch (status) {
    case "waiting_user":
      return "waiting_user";
    case "waiting_approval":
      return "waiting_approval";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "working";
  }
}

/**
 * The tasks of a chat as a chat run starts (recorded in `context_loaded.openTasks`, so a resume and
 * a replay read the same): every task still open, then the ones that ended in the last 24 hours (at
 * most five, the newest), oldest first. Read from the database; nothing here reads text.
 */
export async function openTasksOf(
  db: Db,
  conversationId: string,
  now: Date = new Date(),
): Promise<OpenTaskFact[]> {
  const rows = await listTasks(db, { conversationId });
  const listed: { fact: OpenTaskFact; ended: Date | null }[] = [];
  for (const task of rows) {
    const run = await getRun(db, task.runId);
    if (run === null) continue;
    const state = taskStateOfRun(run.status);
    const ended = state === "done" || state === "failed" || state === "stopped";
    listed.push({
      fact: { id: task.id, title: task.title, state },
      ended: ended ? (run.finishedAt ?? run.updatedAt) : null,
    });
  }
  const open = listed.filter((t) => t.ended === null);
  const recent = listed
    .filter((t) => t.ended !== null && now.getTime() - t.ended.getTime() <= ENDED_TASK_WINDOW_MS)
    .sort((a, b) => (b.ended as Date).getTime() - (a.ended as Date).getTime())
    .slice(0, MAX_ENDED_TASKS_LISTED);
  const keep = new Set([...open, ...recent].map((t) => t.fact.id));
  return listed.filter((t) => keep.has(t.fact.id)).map((t) => t.fact);
}
