import type { Bot, Task } from "@suup/api";
import { useMemo } from "react";
import { useData } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { NEW_REPLIES_TEXT, TASK_STATE_TEXT, taskIsOpen } from "../../data/task-text.js";
import { cx } from "../../lib/cx.js";
import { themeColor } from "../../lib/mascots.js";
import { TaskAvatar } from "../../ui/task-avatar.js";
import { ReplyStroke } from "../../ui/task-label.js";

/** The most tasks a bot lists under itself (the server's own limit of tasks at a time). */
export const SIDEBAR_TASKS_MAX = 3;

/**
 * The tasks a bot lists in the sidebar (KOD-68, docs/DESIGN.md "Barra lateral"): the ones that run
 * or wait for you, and a finished one while its result has replies you have not opened yet. Oldest
 * first, at most three. All from `Task` (the server's state and read cursor), nothing deduced.
 */
export function sidebarTasksOf(tasks: Record<string, Task>, botId: string): Task[] {
  return Object.values(tasks)
    .filter((t) => t.botId === botId && (taskIsOpen(t) || t.unreadReplies > 0))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, SIDEBAR_TASKS_MAX);
}

/**
 * The rows of a bot's tasks under its row, nested like a person's agent: each hangs from the bot by
 * the same curved stroke as the task label, with a small generated face, the name (cut) and the
 * state. Tapping one opens it in the panel on the right.
 */
export function SidebarTasks({ bot }: { bot: Bot }) {
  const allTasks = useData((s) => s.tasks);
  const selectBot = useUi((s) => s.selectBot);
  const openTask = useUi((s) => s.openTask);
  const openTaskId = useUi((s) => s.openTaskId);
  const tasks = useMemo(() => sidebarTasksOf(allTasks, bot.id), [allTasks, bot.id]);
  if (tasks.length === 0) return null;
  const botColor = themeColor(bot, bot.id);
  return (
    <ul
      className="m-0 flex list-none flex-col p-0"
      aria-label={`Tarefas de ${bot.name}`}
      data-testid="sidebar-tasks"
    >
      {tasks.map((task, i) => {
        const unread = task.unreadReplies > 0;
        const stateText = unread ? NEW_REPLIES_TEXT : TASK_STATE_TEXT[task.state];
        return (
          <li key={task.id} className="relative h-8" data-testid="sidebar-task-row">
            <ReplyStroke
              direction="down"
              trunk={i < tasks.length - 1}
              testId="sidebar-task-stroke"
              className="pointer-events-none absolute top-0 left-7 h-8 w-4 text-text-muted opacity-60"
            />
            <button
              type="button"
              className={cx(
                "ml-11 flex h-8 w-[calc(100%-2.75rem)] min-w-0 cursor-pointer items-center gap-2 rounded-row border-0 bg-transparent px-2 text-left text-small text-text-muted hover:bg-hover hover:text-text focus-visible:bg-hover",
                openTaskId === task.id && "bg-sidebar-active text-text",
              )}
              data-testid="sidebar-task"
              data-task={task.id}
              data-task-state={task.state}
              data-task-unread={unread ? "true" : undefined}
              aria-current={openTaskId === task.id ? "true" : undefined}
              title={`${task.title} · ${stateText}`}
              aria-label={`Abrir a tarefa: ${task.title} · ${stateText}`}
              onClick={() => {
                selectBot(bot.id);
                openTask(task.id);
              }}
            >
              <TaskAvatar taskId={task.id} botColor={botColor} size={20} />
              <span
                className="max-w-[65%] min-w-0 flex-none truncate text-text"
                data-testid="sidebar-task-name"
              >
                {task.title}
              </span>
              <span
                className={cx("min-w-0 flex-1 truncate text-right", unread && "text-status-unread")}
                data-testid="sidebar-task-state"
              >
                {stateText}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
