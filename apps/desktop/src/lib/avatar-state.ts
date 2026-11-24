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
 * - `queued` e `running`: trabalhando (`working`); com `paused`, pausado;
 * - `waiting_user` e `waiting_approval`: perguntando (`asking`: precisa de você);
 * - `waiting_timer` (o bot marcou um retorno para si): parado (`idle`), sem marca nenhuma;
 * - `done`: concluído (`done`); `failed`: falhou (`failed`).
 *
 * Nunca um estado em que o corpo vira indicador (`BODY_MORPH_STATES` do motor: `thinking`, os
 * pontinhos, e `waiting`, a órbita): na barra lateral o rosto virava um "C" pequeno e parecia
 * quebrado (dono, 24/11/2026). O avatar mantém o tamanho e a forma em todo estado; o que muda é o
 * movimento e os olhos.
 *
 * Quanto tempo o `done` aparece é decisão de quem desenha (o `Mascot` volta a `idle` sozinho).
 */
export function avatarStateOf(run: RunFacts | null, _toolRunning = false): AvatarStateId {
  if (run === null) return "idle";
  switch (run.status) {
    case "queued":
    case "running":
      return run.paused ? "paused" : "working";
    case "waiting_user":
    case "waiting_approval":
      return "asking";
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
