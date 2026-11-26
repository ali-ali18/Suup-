import type { TaskState } from "@suup/api";
import { CornerDownRight } from "lucide-react";
import { TASK_STATE_TEXT } from "../data/task-text.js";

/**
 * The small label above a bubble or a card that comes from a task (KOD-68, docs/DESIGN.md,
 * "Tarefas"): "↳ <name of the task> · <state>". It is a button: tapping it opens the task's own
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
      className="-mb-1.5 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 self-start border-0 bg-transparent px-1 py-0 text-small text-text-muted transition-colors hover:text-text"
      data-testid="task-label"
      data-task={taskId}
      data-task-state={state}
      title={text}
      aria-label={`Abrir a tarefa: ${text}`}
      onClick={() => onOpen(taskId)}
    >
      <CornerDownRight size={14} aria-hidden="true" className="flex-none" />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>
    </button>
  );
}
