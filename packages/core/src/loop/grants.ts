// Owns the one-time grants that an approval given too late leaves behind (docs/APROVACOES.md,
// "Aprovação depois de muito tempo"), and the words the model reads about them. A grant is the
// user's approval of ONE exact call (tool and arguments); it lives in the run's log, so it dies
// with the run, and a replay rebuilds it from the same events.
import type { JsonValue } from "../messages.js";

/**
 * The JSON text of a value with the keys of every object in sorted order. Two values are the same
 * call exactly when their canonical texts are equal: no normalization of the values themselves, no
 * "similar enough".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Whether a new call is exactly the call a grant was given for. */
export function sameCall(
  a: { tool: string; args: JsonValue },
  b: { name: string; args: unknown },
): boolean {
  return a.tool === b.name && canonicalJson(a.args) === canonicalJson(b.args);
}

/** "40 min", "5 h", "3 d": how long a card waited, for the notice and the card row. */
export function formatWaited(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * What the model reads in place of the result of a call that was approved too late. It goes in a
 * harness notice, never as a message of the user.
 */
export function renderStaleApprovalNotice(input: { tool: string; waitedMs: number }): string {
  return `Aviso do sistema: o usuário aprovou esta chamada exata a "${input.tool}" depois de ${formatWaited(input.waitedMs)}, e por isso ela NÃO foi executada agora: o estado das coisas pode ter mudado nesse tempo. Confira se ela ainda faz sentido antes de contar com ela. Se ainda faz, chame "${input.tool}" de novo com exatamente os mesmos argumentos (vale uma vez, sem novo cartão). Se não faz mais, não chame, e conte ao usuário por quê. Ao retomar, diga ao usuário, na sua mensagem, que você está retomando a tarefa antiga.`;
}
