import type { RunStatus } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";

/** O que o avatar precisa saber da execução mais recente do bot. */
export interface RunFacts {
  status: RunStatus;
  /** A pessoa pausou a execução (só vale com `queued` ou `running`). */
  paused: boolean;
}

/**
 * O estado do avatar a partir da execução do bot: a ÚNICA ligação entre o que o Suup sabe e o que
 * o motor de avatar sabe fazer.
 *
 * - sem execução, ou cancelada: parado (`idle`);
 * - `queued` e `running`: pensando (`thinking`), ou trabalhando (`working`) enquanto uma
 *   ferramenta roda (`toolRunning`); com `paused`, pausado;
 * - `waiting_user`: perguntando (`asking`); `waiting_approval`: esperando (`waiting`);
 * - `waiting_timer` (o bot marcou um retorno para si): parado (`idle`), sem marca nenhuma;
 * - `done`: concluído (`done`); `failed`: falhou (`failed`).
 *
 * Quanto tempo o `done` aparece é decisão de quem desenha (o `Mascot` volta a `idle` sozinho).
 */
export function avatarStateOf(run: RunFacts | null, toolRunning = false): AvatarStateId {
  if (run === null) return "idle";
  switch (run.status) {
    case "queued":
      return run.paused ? "paused" : "thinking";
    case "running":
      if (run.paused) return "paused";
      return toolRunning ? "working" : "thinking";
    case "waiting_user":
      return "asking";
    case "waiting_approval":
      return "waiting";
    case "waiting_timer":
      return "idle";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "idle";
  }
}
