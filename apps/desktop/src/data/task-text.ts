import type { Task, TaskState } from "@suup/api";

/** The state of a task in plain pt-BR, as the person reads it (docs/DESIGN.md, "Tarefas"). */
export const TASK_STATE_TEXT: Record<TaskState, string> = {
  working: "Trabalhando…",
  waiting_user: "Aguardando sua resposta",
  waiting_approval: "Aguardando sua aprovação",
  done: "Concluída",
  failed: "Não concluída",
  stopped: "Parada",
};

/** "1 atualização", "3 atualizações", "Nenhuma atualização ainda". */
export function updatesText(count: number): string {
  if (count <= 0) return "Nenhuma atualização ainda";
  return count === 1 ? "1 atualização" : `${count} atualizações`;
}

/** Whether the person can still write to the task (it has not ended). */
export const taskIsOpen = (task: Pick<Task, "state">): boolean =>
  task.state === "working" || task.state === "waiting_user" || task.state === "waiting_approval";
