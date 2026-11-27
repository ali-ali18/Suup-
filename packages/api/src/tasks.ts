import { z } from "zod";
import { intQuery, isoDate, list, uuid } from "./common.js";
import { messageSchema } from "./conversations.js";

/**
 * Where a task is, for the person (KOD-68, docs/TAREFAS.md). It comes from the state of the task's
 * run: `working` (queued, running or parked for a return), `waiting_user` (the task asked something,
 * answered in its own view), `waiting_approval` (a card waits in the chat that asked), `done`,
 * `failed` and `stopped` (the user ended it).
 */
export const TASK_STATES = [
  "working",
  "waiting_user",
  "waiting_approval",
  "done",
  "failed",
  "stopped",
] as const;
export const taskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof taskStateSchema>;

/**
 * A task of a bot: a run of the same bot, in a conversation of its own, started from a chat.
 * `conversationId` is the chat where it was asked (its result and its approval cards come back
 * there); `taskConversationId` is the conversation of the task itself (`GET /v1/conversations/{id}/messages`
 * reads its messages).
 */
export const taskSchema = z.object({
  id: uuid,
  botId: uuid,
  conversationId: uuid,
  taskConversationId: uuid,
  /** The run that does the work. */
  runId: uuid,
  /** The chat run that opened it. */
  fromRunId: uuid.nullable(),
  /** The chat turn that delivered its result, once opened. */
  closingRunId: uuid.nullable(),
  /** The name the person sees. */
  title: z.string(),
  state: taskStateSchema,
  /**
   * How many of the task's replies (the bot's messages in its own conversation) the person has not
   * seen: the label above the bubble says "Novas respostas" while it is above 0, until the task's
   * view is opened (`POST /v1/tasks/{id}/read`).
   */
  unreadReplies: z.number().int().nonnegative(),
  /**
   * The user messages of the chat that the task was started from, as the person wrote them (copied
   * from the database by id when the task started, never reworded by the model): the task's own view
   * quotes them as "the request". Empty when the bot cited none.
   */
  sourceMessages: z.array(z.object({ id: uuid, text: z.string() })),
  createdAt: isoDate,
  /** When the state last changed (the run's): a client keeps the newest version it saw. */
  updatedAt: isoDate,
  /** When the task's run ended; `null` while it works. */
  finishedAt: isoDate.nullable(),
});
export type Task = z.infer<typeof taskSchema>;
export const taskListSchema = list(taskSchema);

export const listTasksQuerySchema = z.object({
  /** Only the tasks asked in this chat. */
  conversationId: uuid.optional(),
  botId: uuid.optional(),
  limit: intQuery(1, 200).default(100),
});
export type ListTasksQuery = { conversationId?: string; botId?: string; limit?: number };

/** `POST /v1/tasks/{id}/messages`: what the person wrote in the task's own view. */
export const replyToTaskBodySchema = z.object({
  text: z
    .string()
    .refine((t) => t.trim().length > 0, "a mensagem está vazia")
    .pipe(z.string().max(100_000)),
});
export type ReplyToTaskBody = z.input<typeof replyToTaskBodySchema>;
export const replyToTaskResultSchema = z.object({
  /** Your message, stored in the task's conversation (`sent` until the task reads it). */
  message: messageSchema,
  task: taskSchema,
});
export type ReplyToTaskResult = z.infer<typeof replyToTaskResultSchema>;
