import type { MessageAttachment, Task } from "@suup/api";
import { ChevronRight, ListChecks } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { orderedMessages } from "../../data/reducers.js";
import { NEW_REPLIES_TEXT, TASK_STATE_TEXT, taskIsOpen } from "../../data/task-text.js";
import { cx } from "../../lib/cx.js";
import { themeColor } from "../../lib/mascots.js";
import { FILE_ICON } from "../../ui/file-card.js";
import { TaskAvatar } from "../../ui/task-avatar.js";
import { agoText, dayName } from "../chat/timeline.js";
import { PanelRow } from "./ActivityTab.js";

/** The colour of a task's state line: only the app's status tokens (docs/DESIGN.md §5b). */
function stateTone(task: Task): string {
  if (task.unreadReplies > 0) return "text-status-unread";
  switch (task.state) {
    case "waiting_user":
    case "waiting_approval":
      return "text-status-waiting";
    case "done":
      return "text-success-text";
    case "failed":
      return "text-danger-text";
    default:
      return "text-text-muted";
  }
}

/**
 * The tasks of a bot, grouped for the Tarefas tab (KOD-68): the ones that run or wait by the day
 * they were asked ("Hoje", "Ontem", the date), newest first, and the finished ones (done, failed,
 * stopped) apart, in one group. From `Task` (the server's state), nothing deduced.
 */
export function groupTasks(
  tasks: Record<string, Task>,
  botId: string,
  now: Date,
): { days: { name: string; tasks: Task[] }[]; resolved: Task[] } {
  const mine = Object.values(tasks).filter((t) => t.botId === botId);
  const open = mine.filter(taskIsOpen).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const resolved = mine
    .filter((t) => !taskIsOpen(t))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const days: { name: string; tasks: Task[] }[] = [];
  for (const task of open) {
    const name = dayName(new Date(task.createdAt), now);
    const last = days[days.length - 1];
    if (last?.name === name) last.tasks.push(task);
    else days.push({ name, tasks: [task] });
  }
  return { days, resolved };
}

/** The files a task's conversation handed over (`send_file`), as the API returns them; none, none. */
function useTaskFiles(task: Task): MessageAttachment[] {
  const slice = useData((s) => s.messages[task.taskConversationId]);
  return useMemo(
    () =>
      orderedMessages(slice).flatMap((m) => (m.authorKind === "user" ? [] : (m.attachments ?? []))),
    [slice],
  );
}

function TaskRow({
  task,
  botColor,
  now,
}: {
  task: Task;
  botColor: ReturnType<typeof themeColor> | null;
  now: Date;
}) {
  const { sync } = useServices();
  const openTask = useUi((s) => s.openTask);
  const loaded = useData((s) => s.messages[task.taskConversationId] !== undefined);
  // The files come with the task's messages: read them once for the row.
  useEffect(() => {
    if (!loaded) void sync.loadNewestMessages(task.taskConversationId);
  }, [loaded, sync, task.taskConversationId]);
  const files = useTaskFiles(task);
  const unread = task.unreadReplies > 0;
  const stateText = unread ? NEW_REPLIES_TEXT : TASK_STATE_TEXT[task.state];
  return (
    <div data-testid="task-item">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-2.5 text-left text-text hover:bg-hover"
        data-testid="task-row"
        data-task={task.id}
        data-task-state={task.state}
        data-task-unread={unread ? "true" : undefined}
        aria-label={`Abrir a tarefa: ${task.title} · ${stateText}`}
        onClick={() => openTask(task.id)}
      >
        <TaskAvatar taskId={task.id} botColor={botColor} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate text-label font-label"
            data-testid="task-row-name"
            title={task.title}
          >
            {task.title}
          </span>
          <span
            className={cx("text-small whitespace-nowrap", stateTone(task))}
            data-testid="task-row-state"
          >
            {stateText}
          </span>
        </span>
        <span
          className="flex-none self-start pt-0.5 text-small text-text-muted"
          data-testid="task-row-time"
        >
          {agoText(new Date(task.updatedAt), now)}
        </span>
      </button>
      {files.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 px-3 pb-2.5 pl-[3.75rem]">
          {files.map((file) => {
            const Icon = FILE_ICON[file.kind];
            return (
              <li
                key={file.id}
                className="flex min-w-0 items-center gap-2 rounded-row border border-border bg-raised px-2.5 py-1.5 text-small"
                data-testid="task-file"
              >
                <Icon size={14} aria-hidden="true" className="flex-none text-text-muted" />
                <span className="truncate">{file.name}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The "Tarefas" tab of the bot's panel: its tasks by day, the finished ones in a closed group. */
export function TasksTab({ botId }: { botId: string }) {
  const bot = useData((s) => s.bots[botId]);
  const allTasks = useData((s) => s.tasks);
  const [now] = useState(() => new Date());
  const [showResolved, setShowResolved] = useState(false);
  const { days, resolved } = useMemo(
    () => groupTasks(allTasks, botId, now),
    [allTasks, botId, now],
  );
  const botColor = bot === undefined ? null : themeColor(bot, bot.id);
  const card = "overflow-hidden rounded-card border border-border bg-surface";
  if (days.length === 0 && resolved.length === 0) {
    return (
      <div className={card} data-testid="tasks-empty">
        <PanelRow
          icon={<ListChecks size={16} />}
          title="Nenhuma tarefa"
          text="Peça um trabalho longo no chat e ele vira uma tarefa."
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="tasks-tab">
      {days.map((day) => (
        <section key={day.name} aria-label={day.name} data-testid="tasks-day" data-day={day.name}>
          <h3 className="px-1 pb-2 text-small font-normal text-text-muted">{day.name}</h3>
          <div className={card}>
            {day.tasks.map((task) => (
              <TaskRow key={task.id} task={task} botColor={botColor} now={now} />
            ))}
          </div>
        </section>
      ))}
      {resolved.length > 0 && (
        <section aria-label="Resolvidas" data-testid="tasks-resolved">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1 pb-2 text-left text-small text-text-muted hover:text-text"
            aria-expanded={showResolved}
            data-testid="tasks-resolved-toggle"
            onClick={() => setShowResolved((v) => !v)}
          >
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={cx(
                "transition-transform duration-(--duration-base)",
                showResolved && "rotate-90",
              )}
            />
            Resolvidas · {resolved.length}
          </button>
          {showResolved && (
            <div className={card}>
              {resolved.map((task) => (
                <TaskRow key={task.id} task={task} botColor={botColor} now={now} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
