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

/** What the label of a task says in place of its state while it has replies you have not seen. */
export const NEW_REPLIES_TEXT = "Novas respostas";

/** "1 atualização", "3 atualizações", "Nenhuma atualização ainda". */
export function updatesText(count: number): string {
  if (count <= 0) return "Nenhuma atualização ainda";
  return count === 1 ? "1 atualização" : `${count} atualizações`;
}

/** Whether the person can still write to the task (it has not ended). */
export const taskIsOpen = (task: Pick<Task, "state">): boolean =>
  task.state === "working" || task.state === "waiting_user" || task.state === "waiting_approval";

/** What an approval of a task says in the task's data panel, in plain words. */
export const APPROVAL_STATE_TEXT: Record<string, string> = {
  pending: "Aguardando você",
  approved: "Aprovada",
  denied: "Recusada",
  cancelled: "Cancelada",
  expired: "Expirou",
};

/** The cost of a task's run in dollars, as the server counted it (`"0.034100"` becomes "US$ 0,03"). */
export function costText(costUsd: string): string {
  const value = Number(costUsd);
  if (!Number.isFinite(value)) return costUsd;
  return `US$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 4 : 2 })}`;
}
