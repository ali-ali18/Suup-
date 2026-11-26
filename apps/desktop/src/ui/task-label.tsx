import type { TaskState } from "@suup/api";
import { MessageCircle } from "lucide-react";
import { TASK_STATE_TEXT } from "../data/task-text.js";

/**
 * The small label above a bubble or a card that comes from a task (KOD-68, docs/DESIGN.md,
 * "Tarefas"): one line, no box: a thin reply stroke curving toward the bubble, an outline chat icon, the name
 * (cut with an ellipsis when long) and " · <state>" (never cut). It is a button: tapping it opens the task's own
 * view. The state is the server's (`Task.state`) in plain words; nothing here decides anything.
 */
export function TaskLabel({
  taskId,
  title,
  state,
  onOpen,
}: {
  taskId: string;
  title: string;
  state: TaskState;
  onOpen(taskId: string): void;
}) {
  const text = `${title} · ${TASK_STATE_TEXT[state]}`;
  return (
    <button
      type="button"
      className="relative -mb-1.5 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 self-start border-0 bg-transparent py-0 pr-1 pl-8 text-small text-text-muted transition-colors hover:text-text"
      data-testid="task-label"
      data-task={taskId}
      data-task-state={state}
      title={text}
      aria-label={`Abrir a tarefa: ${text}`}
      onClick={() => onOpen(taskId)}
    >
      <span
        aria-hidden="true"
        data-testid="task-label-stroke"
        className="absolute top-2.5 left-4 h-5 w-3 rounded-tl-[10px] border-t border-l border-current opacity-60"
      />
      <MessageCircle size={14} aria-hidden="true" className="flex-none" />
      <span className="flex min-w-0 items-baseline whitespace-nowrap">
        <span
          data-testid="task-label-name"
          className="max-w-40 min-w-0 overflow-hidden text-ellipsis"
        >
          {title}
        </span>
        <span className="flex-none whitespace-pre">{` · ${TASK_STATE_TEXT[state]}`}</span>
      </span>
    </button>
  );
}
