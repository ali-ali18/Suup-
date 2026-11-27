// Owns the tasks of a bot (KOD-68, docs/TAREFAS.md): a run of the SAME bot with the origin `task`,
// in a conversation of its own (kind `task`), started from the chat where the user asked. The run is
// outside the one-active-run-per-conversation index, so the chat stays free while it works. The
// state of a task is the state of its run (never copied here).
//
// What this file guarantees, in the database and not in a prompt: at most `MAX_OPEN_TASKS` open
// tasks per bot, a task never starts a task, the user messages a task cites are copied from the
// database by id (they must be user messages of the chat that asked), a reply goes to the inbox of
// the task's own run, and the result goes back to the chat once.
import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { markConversationRead } from "./conversations.js";
import { postInbox } from "./inbox.js";
import { appendMessage, type Message } from "./messages.js";
import { createRun, getRun } from "./runs.js";
import type { Run } from "./types.js";

/** Most tasks open at once for one bot (a task whose run has not ended). */
export const MAX_OPEN_TASKS = 3;

/** Most user messages a task may cite. */
export const MAX_TASK_SOURCE_MESSAGES = 8;

export type TaskErrorCode =
  | "not_found"
  | "archived"
  | "not_chat"
  | "nested"
  | "limit"
  | "invalid_messages"
  | "finished"
  | "wrong_chat";

/** What was asked of a task cannot be done (or is not allowed) in the state it is in. */
export class TaskError extends Error {
  override name = "TaskError";
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Task {
  id: string;
  botId: string;
  /** The chat where the task was asked: its result and its approval cards come back there. */
  conversationId: string;
  /** The chat run that opened it. */
  fromRunId: string | null;
  /** The run that does the work. */
  runId: string;
  /** The conversation of the task itself (its messages). */
  taskConversationId: string;
  title: string;
  brief: string;
  sourceMessageIds: string[];
  /** The chat turn that delivered the result, once opened. */
  closingRunId: string | null;
  /** The end of the task was handled: result delivered to the chat, or nothing to deliver. */
  closedAt: Date | null;
  createdAt: Date;
}

interface TaskRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  from_run_id: string | null;
  run_id: string;
  task_conversation_id: string;
  title: string;
  brief: string;
  source_message_ids: string[];
  closing_run_id: string | null;
  closed_at: Date | null;
  created_at: Date;
}

const mapTask = (r: TaskRow): Task => ({
  id: r.id,
  botId: r.bot_id,
  conversationId: r.conversation_id,
  fromRunId: r.from_run_id,
  runId: r.run_id,
  taskConversationId: r.task_conversation_id,
  title: r.title,
  brief: r.brief,
  sourceMessageIds: r.source_message_ids,
  closingRunId: r.closing_run_id,
  closedAt: r.closed_at,
  createdAt: r.created_at,
});

const OPEN_STATUSES = ["queued", "running", "waiting_user", "waiting_approval", "waiting_timer"];
const TERMINAL = ["done", "failed", "cancelled"];

export interface CreateTaskInput {
  /** The chat run that starts the task. */
  fromRunId: string;
  title: string;
  /** The request, already composed (objective, what is known, what to return, how far to go). */
  brief: string;
  /** Ids of the user messages of that chat that ground the request. */
  sourceMessageIds: string[];
  /** Default `MAX_OPEN_TASKS`. */
  maxOpen?: number;
}

/**
 * Starts a task from a chat run, atomically: the task conversation, the run (`origin: "task"`, in
 * the queue like any run) and the link. Refused (`TaskError`) when:
 * - the run is itself a task (a task starts no task) or is not a chat run of the user;
 * - the bot is archived, or already has `maxOpen` open tasks;
 * - a cited message is not a USER message of the chat the run belongs to.
 * The same task (same run, title and brief) twice is one: the second call returns the first with
 * `created: false`.
 */
export async function createTask(
  db: Db,
  input: CreateTaskInput,
): Promise<{ task: Task; run: Run; created: boolean }> {
  const fromRunId = z.uuid().parse(input.fromRunId);
  const title = z.string().trim().min(1).max(200).parse(input.title);
  const brief = z.string().trim().min(1).parse(input.brief);
  const sourceIds = [
    ...new Set(z.array(z.uuid()).max(MAX_TASK_SOURCE_MESSAGES).parse(input.sourceMessageIds)),
  ];
  const from = await getRun(db, fromRunId);
  if (from === null) throw new TaskError("not_found", "A execução que abre a tarefa não existe.");
  if (from.origin === "task") {
    throw new TaskError("nested", "Uma tarefa não abre outra tarefa.");
  }
  if (from.origin !== "user" || from.conversationId === null || from.conversationId === undefined) {
    throw new TaskError("not_chat", "Só uma conversa do usuário com o bot abre uma tarefa.");
  }
  const chatId = from.conversationId;
  return withTransaction(db, async (tx) => {
    // The same lock `sendConversationMessage` takes: one writer at a time in the chat.
    await tx.sql`select 1 from conversations where id = ${chatId} for no key update`;
    const [bot] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from bots where id = ${from.botId} for no key update`;
    if (bot === undefined || bot.archived_at !== null) {
      throw new TaskError("archived", "O bot está arquivado.");
    }
    const key = (
      await tx.sql<{ k: string }[]>`
        select md5(suup_text_key(${`${title}\n${brief}`})) as k`
    )[0]?.k as string;
    const [same] = await tx.sql<TaskRow[]>`
      select * from tasks where from_run_id = ${fromRunId} and start_key = ${key}`;
    if (same !== undefined) {
      const run = (await getRun(tx, same.run_id)) as Run;
      return { task: mapTask(same), run, created: false };
    }
    if (sourceIds.length > 0) {
      const found = await tx.sql<{ id: string }[]>`
        select id from messages
        where id = any(${sourceIds}::uuid[]) and conversation_id = ${chatId}
          and author_kind = 'user'`;
      if (found.length !== sourceIds.length) {
        throw new TaskError(
          "invalid_messages",
          "Alguma das mensagens citadas não é uma mensagem do usuário nesta conversa.",
        );
      }
    }
    const [open] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from tasks t join runs r on r.id = t.run_id
      where t.bot_id = ${from.botId} and r.status = any(${OPEN_STATUSES}::text[])`;
    if ((open?.n ?? 0) >= (input.maxOpen ?? MAX_OPEN_TASKS)) {
      throw new TaskError("limit", `Já há ${open?.n} tarefas em andamento.`);
    }
    // The conversation of the task: a conversation of its own, with the bot as its only member.
    const [conversation] = await tx.sql<{ id: string }[]>`
      insert into conversations (kind, title, reception) values ('task', ${title}, 'done')
      returning id`;
    if (conversation === undefined) throw new Error("insert into conversations returned no row");
    await tx.sql`
      insert into conversation_members (conversation_id, conversation_kind, bot_id)
      values (${conversation.id}, 'task', ${from.botId})`;
    const run = await createRun(tx, {
      botId: from.botId,
      parentRunId: fromRunId,
      conversationId: conversation.id,
      origin: "task",
      objective: brief,
    });
    const [row] = await tx.sql<TaskRow[]>`
      insert into tasks (bot_id, conversation_id, from_run_id, run_id, task_conversation_id, title,
        brief, source_message_ids, start_key)
      values (${from.botId}, ${chatId}, ${fromRunId}, ${run.id}, ${conversation.id}, ${title},
        ${brief}, ${sourceIds}::uuid[], ${key})
      returning *`;
    return { task: mapTask(row as TaskRow), run, created: true };
  });
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  const [row] = await db.sql<TaskRow[]>`select * from tasks where id = ${z.uuid().parse(id)}`;
  return row === undefined ? null : mapTask(row);
}

export async function getTaskByRun(db: Db, runId: string): Promise<Task | null> {
  const [row] = await db.sql<
    TaskRow[]
  >`select * from tasks where run_id = ${z.uuid().parse(runId)}`;
  return row === undefined ? null : mapTask(row);
}

export async function getTaskByClosingRun(db: Db, closingRunId: string): Promise<Task | null> {
  const [row] = await db.sql<TaskRow[]>`
    select * from tasks where closing_run_id = ${z.uuid().parse(closingRunId)}`;
  return row === undefined ? null : mapTask(row);
}

export async function getTaskByConversation(
  db: Db,
  taskConversationId: string,
): Promise<Task | null> {
  const [row] = await db.sql<TaskRow[]>`
    select * from tasks where task_conversation_id = ${z.uuid().parse(taskConversationId)}`;
  return row === undefined ? null : mapTask(row);
}

export interface ListTasksOptions {
  /** Only the tasks asked in this chat. */
  conversationId?: string;
  botId?: string;
  /** Only the tasks whose run has not ended. */
  openOnly?: boolean;
  limit?: number;
}

/** Oldest first (the order the chat shows them in). */
export async function listTasks(db: Db, opts: ListTasksOptions = {}): Promise<Task[]> {
  const { sql } = db;
  const limit = z
    .number()
    .int()
    .positive()
    .parse(opts.limit ?? 200);
  const rows = await sql<TaskRow[]>`
    select t.* from tasks t join runs r on r.id = t.run_id
    where ${opts.conversationId !== undefined ? sql`t.conversation_id = ${opts.conversationId}` : sql`true`}
      and ${opts.botId !== undefined ? sql`t.bot_id = ${opts.botId}` : sql`true`}
      and ${opts.openOnly === true ? sql`r.status = any(${OPEN_STATUSES}::text[])` : sql`true`}
    order by t.created_at, t.id
    limit ${limit}`;
  return rows.map(mapTask);
}

/**
 * What a task run starts from, besides its brief: the user messages it cites, copied from the
 * database by id (their text, as the user wrote it), in the order they were written. `null` when the
 * run is not a task.
 */
export async function taskStartContext(
  db: Db,
  runId: string,
): Promise<{ task: Task; userMessages: { id: string; text: string }[] } | null> {
  const task = await getTaskByRun(db, runId);
  if (task === null) return null;
  const rows =
    task.sourceMessageIds.length === 0
      ? []
      : await db.sql<{ id: string; text: string }[]>`
          select id, text from messages
          where id = any(${task.sourceMessageIds}::uuid[]) and conversation_id = ${task.conversationId}
            and author_kind = 'user'
          order by seq`;
  return { task, userMessages: rows };
}

/** The user messages of a chat that a task may be told about (id and text), newest last. */
export async function recentUserMessages(
  db: Db,
  conversationId: string,
  limit: number,
): Promise<{ id: string; text: string }[]> {
  const rows = await db.sql<{ id: string; text: string }[]>`
    select id, text from messages
    where conversation_id = ${z.uuid().parse(conversationId)} and author_kind = 'user'
    order by seq desc limit ${z.number().int().positive().parse(limit)}`;
  return rows.reverse();
}

/**
 * The user's messages that started a chat run or reached it while it worked (id), oldest first,
 * at most `MAX_TASK_SOURCE_MESSAGES`: what the early brake cites when it moves the work to a task.
 */
export async function userMessagesOfRun(db: Db, runId: string): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`
    select id from messages
    where run_id = ${z.uuid().parse(runId)} and author_kind = 'user'
    order by seq desc limit ${MAX_TASK_SOURCE_MESSAGES}`;
  return rows.map((r) => r.id).reverse();
}

/** Locks a task row and checks its run still works. */
async function openTask(tx: Db, taskId: string): Promise<{ task: Task; run: Run }> {
  const [row] = await tx.sql<TaskRow[]>`select * from tasks where id = ${taskId}`;
  if (row === undefined) throw new TaskError("not_found", "A tarefa não existe.");
  const task = mapTask(row);
  // Conversation first, then the run: the order every writer of a conversation uses.
  await tx.sql`select 1 from conversations where id = ${task.taskConversationId} for no key update`;
  const run = await getRun(tx, task.runId);
  if (run === null) throw new TaskError("not_found", "A execução da tarefa não existe.");
  if (TERMINAL.includes(run.status)) {
    throw new TaskError("finished", "A tarefa já terminou.");
  }
  return { task, run };
}

/**
 * A reply the user wrote in the task's own view: the message is stored in the task conversation
 * (`sent` until the run reads it) and posted to the inbox of the task's run, which reads it at its
 * next safe point; a task that asked and waits for the user is resumed by it. The path is
 * structural: the task id picks the run, never a model. Throws `TaskError("finished")` for a task
 * that ended.
 */
export async function replyToTask(
  db: Db,
  taskId: string,
  text: string,
): Promise<{ message: Message; run: Run; task: Task }> {
  const body = z
    .string()
    .refine((t) => t.trim().length > 0, "text must not be blank")
    .parse(text);
  return withTransaction(db, async (tx) => {
    const { task, run } = await openTask(tx, z.uuid().parse(taskId));
    const message = await appendMessage(tx, {
      conversationId: task.taskConversationId,
      authorKind: "user",
      text: body,
      runId: run.id,
      status: "sent",
    });
    await postInbox(tx, run.id, { kind: "user_message", text: body, messageId: message.id });
    return { message, run: (await getRun(tx, run.id)) ?? run, task };
  });
}

/**
 * What the chat bot forwards to a task (`send_to_task`), from a chat run of the SAME chat that
 * asked for the task. With `messageId` the text is the user's own message, copied from the database
 * (it must be a user message of that chat); with `text` it is the bot's own words, told to the task
 * as such. Delivered like a reply.
 */
export async function forwardToTask(
  db: Db,
  input: { taskId: string; fromConversationId: string; messageId?: string; text?: string },
): Promise<{ message: Message; task: Task; verbatim: boolean }> {
  const taskId = z.uuid().parse(input.taskId);
  return withTransaction(db, async (tx) => {
    const { task, run } = await openTask(tx, taskId);
    if (task.conversationId !== input.fromConversationId) {
      throw new TaskError("wrong_chat", "Esta tarefa foi pedida em outra conversa.");
    }
    if (input.messageId !== undefined) {
      const [source] = await tx.sql<{ text: string }[]>`
        select text from messages
        where id = ${z.uuid().parse(input.messageId)} and conversation_id = ${task.conversationId}
          and author_kind = 'user'`;
      if (source === undefined) {
        throw new TaskError(
          "invalid_messages",
          "A mensagem citada não é uma mensagem do usuário nesta conversa.",
        );
      }
      const message = await appendMessage(tx, {
        conversationId: task.taskConversationId,
        authorKind: "user",
        text: source.text,
        runId: run.id,
        status: "sent",
      });
      await postInbox(tx, run.id, {
        kind: "user_message",
        text: source.text,
        messageId: message.id,
      });
      return { message, task, verbatim: true };
    }
    const words = z
      .string()
      .trim()
      .min(1)
      .parse(input.text ?? "");
    // The bot's own words: shown in the task as the bot's, and told to the run as coming from the
    // chat assistant, never as something the user typed.
    const message = await appendMessage(tx, {
      conversationId: task.taskConversationId,
      authorKind: "bot",
      authorBotId: task.botId,
      text: words,
      runId: run.id,
    });
    await postInbox(tx, run.id, {
      kind: "user_message",
      text: `[Note from the chat assistant, in its own words (not typed by the user)] ${words}`,
    });
    return { message, task, verbatim: false };
  });
}

/**
 * Opens the chat turn that delivers a finished task's result (`origin: "task_result"`, the chat's
 * foreground run), once. Idempotent under the lock of the task row: the task is marked closed in
 * the same transaction, so a second call (another worker, the crash recovery) finds it closed.
 * Returns:
 * - `opened`: the turn was created now;
 * - `busy`: the chat has a run working or waiting: nothing is opened, the result stays pending and is
 *   opened when that run ends (`pendingTaskResults`);
 * - `nothing`: the task is not finished, or its end was already handled.
 */
export async function openTaskResult(
  db: Db,
  taskId: string,
  objective: string,
): Promise<{ state: "opened"; run: Run; task: Task } | { state: "busy" } | { state: "nothing" }> {
  const id = z.uuid().parse(taskId);
  return withTransaction(db, async (tx) => {
    const [peek] = await tx.sql<{ conversation_id: string }[]>`
      select conversation_id from tasks where id = ${id}`;
    if (peek === undefined) return { state: "nothing" } as const;
    await tx.sql`select 1 from conversations where id = ${peek.conversation_id} for no key update`;
    const [row] = await tx.sql<TaskRow[]>`select * from tasks where id = ${id} for update`;
    if (row === undefined || row.closed_at !== null) return { state: "nothing" } as const;
    const task = mapTask(row);
    const taskRun = await getRun(tx, task.runId);
    if (taskRun === null || !TERMINAL.includes(taskRun.status))
      return { state: "nothing" } as const;
    const [active] = await tx.sql<{ id: string }[]>`
      select id from runs
      where conversation_id = ${task.conversationId}
        and origin in ('user', 'reception', 'delegation', 'task_result')
        and status = any(${OPEN_STATUSES}::text[])
      limit 1`;
    if (active !== undefined) return { state: "busy" } as const;
    const [chat] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from conversations where id = ${task.conversationId}`;
    if (chat === undefined || chat.archived_at !== null) {
      await tx.sql`update tasks set closed_at = now() where id = ${id}`;
      return { state: "nothing" } as const;
    }
    const run = await createRun(tx, {
      botId: task.botId,
      parentRunId: taskRun.id,
      conversationId: task.conversationId,
      origin: "task_result",
      objective,
    });
    const [closed] = await tx.sql<TaskRow[]>`
      update tasks set closing_run_id = ${run.id}, closed_at = now() where id = ${id} returning *`;
    return { state: "opened", run, task: mapTask(closed as TaskRow) } as const;
  });
}

/** Marks a finished task as handled with nothing to deliver (the user stopped it). Idempotent. */
export async function closeTaskWithoutResult(db: Db, taskId: string): Promise<void> {
  await db.sql`update tasks set closed_at = now() where id = ${z.uuid().parse(taskId)} and closed_at is null`;
}

/**
 * The finished tasks whose end was not handled yet, oldest first: the crash recovery looks at them,
 * and so does a chat that just became free (`conversationId`).
 */
export async function pendingTaskResults(
  db: Db,
  opts: { conversationId?: string; limit?: number } = {},
): Promise<{ task: Task; run: Run }[]> {
  const { sql } = db;
  const rows = await sql<TaskRow[]>`
    select t.* from tasks t join runs r on r.id = t.run_id
    where t.closed_at is null and r.status = any(${TERMINAL}::text[])
      and ${opts.conversationId !== undefined ? sql`t.conversation_id = ${opts.conversationId}` : sql`true`}
    order by r.finished_at nulls last, t.created_at, t.id
    limit ${z
      .number()
      .int()
      .positive()
      .parse(opts.limit ?? 50)}`;
  const out: { task: Task; run: Run }[] = [];
  for (const row of rows) {
    const run = await getRun(db, row.run_id);
    if (run !== null) out.push({ task: mapTask(row), run });
  }
  return out;
}

/**
 * How many replies of each task the person has not seen yet (KOD-68): the bot's messages in the
 * task's own conversation after that conversation's read cursor (`conversations.last_read_seq`, the
 * same cursor a chat has; the user's own messages and the run's event lines never count). A task
 * with none is absent from the map.
 */
export async function taskUnreadReplies(
  db: Db,
  taskIds: readonly string[],
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const ids = z.array(z.uuid()).parse([...taskIds]);
  const rows = await db.sql<{ id: string; n: string }[]>`
    select t.id, count(*) as n
    from tasks t
    join conversations c on c.id = t.task_conversation_id
    join messages m on m.conversation_id = c.id
    where t.id = any(${ids}::uuid[])
      and m.author_kind <> 'user' and m.event_seq is null and m.seq > c.last_read_seq
    group by t.id`;
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/**
 * The person opened the task's own view: everything in it counts as read. It never moves the cursor
 * backwards and is idempotent. `null` for a task that does not exist.
 */
export async function markTaskRead(db: Db, taskId: string): Promise<Task | null> {
  const task = await getTask(db, taskId);
  if (task === null) return null;
  await markConversationRead(db, task.taskConversationId);
  return task;
}
