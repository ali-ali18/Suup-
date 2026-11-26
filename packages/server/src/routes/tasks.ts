import { listTasksQuerySchema, replyToTaskBodySchema } from "@suup/api";
import {
  cancelRun,
  getRun,
  getTask,
  listTasks,
  markTaskRead,
  replyToTask,
  taskUnreadReplies,
} from "@suup/db";
import { applyStatusEffects, finishRun } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toMessageDto, toTaskDto } from "../mappers.js";

/** The task as the API says it: the row, with the state of its run. */
async function taskBody(ctx: Parameters<Route["handler"]>[0], taskId: string) {
  const { db } = ctx.runtime;
  const task = await getTask(db, taskId);
  const run = task === null ? null : await getRun(db, task.runId);
  if (task === null || run === null) throw new HttpError("not_found", "Tarefa não encontrada.");
  const unread = await taskUnreadReplies(db, [task.id]);
  return toTaskDto(task, run, unread.get(task.id) ?? 0);
}

export const taskRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/tasks",
    async handler(ctx) {
      const query = ctx.query(listTasksQuerySchema);
      const { db } = ctx.runtime;
      const tasks = await listTasks(db, {
        limit: query.limit,
        ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
        ...(query.botId === undefined ? {} : { botId: query.botId }),
      });
      const unread = await taskUnreadReplies(
        db,
        tasks.map((t) => t.id),
      );
      const items = [];
      for (const task of tasks) {
        const run = await getRun(db, task.runId);
        if (run !== null) items.push(toTaskDto(task, run, unread.get(task.id) ?? 0));
      }
      return { body: { items } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/tasks/:id",
    async handler(ctx) {
      return { body: await taskBody(ctx, ctx.uuid("id")) };
    },
  },
  {
    // What the person wrote in the task's own view: it goes straight to the inbox of the task's run
    // (the task id picks the run; nothing in a message does). The task reads it at its next safe
    // point, and a task that asked something and waits for the person is resumed by it.
    method: "POST",
    pattern: "/v1/tasks/:id/messages",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(replyToTaskBodySchema);
      const sent = await replyToTask(ctx.runtime.db, id, body.text);
      return {
        status: 201,
        body: {
          message: toMessageDto(sent.message),
          task: toTaskDto(sent.task, sent.run, 0),
        },
      };
    },
  },
  {
    // The person opened the task's own view: its replies count as read (the same cursor a chat
    // has, on the task's conversation). Idempotent; the stream tells every open screen.
    method: "POST",
    pattern: "/v1/tasks/:id/read",
    async handler(ctx) {
      const id = ctx.uuid("id");
      if ((await markTaskRead(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Tarefa não encontrada.");
      }
      return { body: await taskBody(ctx, id) };
    },
  },
  {
    // The existing stop of a run, by the task id: the task ends as `stopped` and nothing is
    // delivered to the chat.
    method: "POST",
    pattern: "/v1/tasks/:id/stop",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const { db } = ctx.runtime;
      const task = await getTask(db, id);
      if (task === null) throw new HttpError("not_found", "Tarefa não encontrada.");
      const run = await cancelRun(db, task.runId, {
        onStatusSet: async (tx, done) => {
          await applyStatusEffects(tx, done);
        },
      });
      // A run nobody holds (waiting for an approval) is cancelled right here; any other is
      // cancelled by the worker, which writes the notice itself.
      if (run.status === "cancelled") {
        await finishRun(db, run.id, { redact: (value) => ctx.runtime.redactJson(value) });
      }
      return { body: await taskBody(ctx, task.id) };
    },
  },
];
