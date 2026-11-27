import { MessageCircle } from "lucide-react";

/**
 * The link to a task inside the bubble of the message that opened it or brought its result (KOD-68,
 * docs/DESIGN.md, "Tarefas"): the outline chat icon and the name of the task, in the text colour,
 * underlined like every link (§4), never blue. It is a button: it opens the task's own view. Where
 * it appears comes from structure (the task the server linked to that message), never from words.
 */
export function TaskLink({
  taskId,
  title,
  onOpen,
}: {
  taskId: string;
  title: string;
  onOpen(taskId: string): void;
}) {
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit"
      data-testid="task-link"
      data-task={taskId}
      title={title}
      aria-label={`Abrir a tarefa: ${title}`}
      onClick={() => onOpen(taskId)}
    >
      <MessageCircle size={14} aria-hidden="true" className="flex-none" />
      <span className="min-w-0 truncate underline underline-offset-3">{title}</span>
    </button>
  );
}
