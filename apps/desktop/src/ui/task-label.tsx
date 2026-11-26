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
      className="group relative -mb-1.5 inline-flex max-w-full min-w-0 cursor-pointer items-center self-start border-0 bg-transparent p-0 pl-10 text-small text-text-muted transition-colors outline-none hover:text-text focus-visible:text-text"
      data-testid="task-label"
      data-task={taskId}
      data-task-state={state}
      title={text}
      aria-label={`Abrir a tarefa: ${text}`}
      onClick={() => onOpen(taskId)}
    >
      <svg
        aria-hidden="true"
        data-testid="task-label-stroke"
        viewBox="0 0 16 16"
        className="absolute top-2 left-4 size-4 overflow-visible opacity-60"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M1 15 V13 A12 12 0 0 1 13 1 H15" />
      </svg>
      <span
        data-testid="task-label-body"
        className="flex min-w-0 items-center gap-1.5 rounded-row px-2 transition-colors group-hover:bg-hover group-focus-visible:bg-hover"
      >
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
      </span>
    </button>
  );
}
