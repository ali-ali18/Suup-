import type { Task } from "@suup/api";
import type { Db } from "@suup/db";
import { type getRun, type Task as TaskRow, taskStartContext, taskUnreadReplies } from "@suup/db";
import { toTaskDto } from "./mappers.js";

type Run = NonNullable<Awaited<ReturnType<typeof getRun>>>;

/**
 * The task as the API says it: the row, the state of its run, how many replies the person has not
 * seen and the user messages the task was started from (the cited ones, or else the message of the turn that opened it) (the "request" its view quotes).
 */
export async function taskDtoOf(db: Db, task: TaskRow, run: Run): Promise<Task> {
  const unread = await taskUnreadReplies(db, [task.id]);
  const start = await taskStartContext(db, task.runId);
  let request = start?.userMessages ?? [];
  if (request.length === 0 && task.fromRunId !== null) {
    // The bot cited no message: the request is the user message that started the chat turn that
    // opened the task (structure, for display only; the task itself still sees only what was cited).
    request = await db.sql<{ id: string; text: string }[]>`
      select id, text from messages
      where run_id = ${task.fromRunId} and conversation_id = ${task.conversationId}
        and author_kind = 'user'
      order by seq`;
  }
  return toTaskDto(task, run, unread.get(task.id) ?? 0, request);
}
