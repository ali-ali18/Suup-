import type { TaskState } from "@suup/api";
import { MessageCircle } from "lucide-react";
import { NEW_REPLIES_TEXT, TASK_STATE_TEXT } from "../data/task-text.js";
import { cx } from "../lib/cx.js";

/**
 * The thin curved stroke of a reply (KOD-68): one line with round caps that comes from below and
 * curves a quarter circle (radius 12) toward a bubble, 2 px thick, in the current colour.
 */
export function ReplyStroke({ testId, className }: { testId?: string; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      data-testid={testId}
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M1 15 V13 A12 12 0 0 1 13 1 H15" />
    </svg>
  );
}

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
  unread = false,
  onOpen,
}: {
  taskId: string;
  title: string;
  state: TaskState;
  /** The task has replies the person has not seen: "Novas respostas" in the unread colour. */
  unread?: boolean;
  onOpen(taskId: string): void;
}) {
  const stateText = unread ? NEW_REPLIES_TEXT : TASK_STATE_TEXT[state];
  const text = `${title} · ${stateText}`;
  return (
    <button
      type="button"
      className="group relative -mb-1.5 inline-flex max-w-full min-w-0 cursor-pointer items-center self-start border-0 bg-transparent p-0 pl-9 text-small text-text-muted transition-colors outline-none hover:text-text focus-visible:text-text"
      data-testid="task-label"
      data-task={taskId}
      data-task-state={state}
      data-task-unread={unread ? "true" : undefined}
      title={text}
      aria-label={`Abrir a tarefa: ${text}`}
      onClick={() => onOpen(taskId)}
    >
      <ReplyStroke
        testId="task-label-stroke"
        className="absolute top-2 left-4 size-4 overflow-visible opacity-60"
      />
      <span
        data-testid="task-label-body"
        className="flex min-w-0 items-center gap-1.5 rounded-row px-1 transition-colors group-hover:bg-hover group-focus-visible:bg-hover"
      >
        <MessageCircle size={14} aria-hidden="true" className="flex-none" />
        <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
          <span
            data-testid="task-label-name"
            className="max-w-40 min-w-0 overflow-hidden text-ellipsis"
          >
            {title}
          </span>
          <span data-testid="task-label-dot" aria-hidden="true" className="flex-none">
            ·
          </span>
          <span
            data-testid="task-label-state"
            className={cx("flex-none", unread && "text-status-unread")}
          >
            {stateText}
          </span>
        </span>
      </span>
    </button>
  );
}
