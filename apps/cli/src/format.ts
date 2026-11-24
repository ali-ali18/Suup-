import type { FailureOrigin, RunStatus, ToolOutcome } from "@suup/core";

const STATUS_PT: Record<RunStatus, string> = {
  queued: "na fila",
  running: "em execução",
  waiting_approval: "aguardando aprovação",
  waiting_user: "aguardando você",
  waiting_timer: "aguardando o retorno agendado",
  done: "concluída",
  failed: "falhou",
  cancelled: "cancelada",
};

export function statusPt(status: string): string {
  return STATUS_PT[status as RunStatus] ?? status;
}

const OUTCOME_PT: Record<ToolOutcome, string> = {
  ok: "ok",
  tool_error: "erro da ferramenta",
  invalid_args: "argumentos inválidos",
  unknown_tool: "ferramenta desconhecida",
  timeout: "tempo esgotado",
  aborted: "interrompida",
  crashed: "falhou de forma inesperada",
  denied: "negada",
};

export function outcomePt(outcome: string): string {
  return OUTCOME_PT[outcome as ToolOutcome] ?? outcome;
}

/** What each failure origin means (PLANO 4.13), in one line each. */
export const ORIGIN_EXPLANATION: Record<FailureOrigin, string> = {
  provider:
    "o provedor do modelo falhou (rede, autenticação, limite de taxa, resposta inválida): problema de infraestrutura ou de configuração do provedor, não uma decisão do modelo.",
  model:
    "o modelo se comportou mal (recusou, parou sem concluir, repetiu a mesma chamada ou não fez progresso): veja o que ele recebeu e teste de novo com `suup resend`.",
  tool: "uma ferramenta falhou ou a máquina dos bots não respondeu: o problema está na ferramenta ou na máquina, não no modelo.",
  harness:
    "falha do próprio harness (bug, invariante quebrada, configuração do bot inválida): não é culpa do modelo; use `suup replay` para reproduzir.",
  limit:
    "um limite configurado foi atingido (turnos, custo ou tempo): aumente o limite do bot ou divida a tarefa.",
  approval: "uma aprovação necessária foi negada.",
  user: "o usuário encerrou a execução.",
};

export function originExplanation(origin: string): string {
  return ORIGIN_EXPLANATION[origin as FailureOrigin] ?? "origem desconhecida.";
}

const nf = new Intl.NumberFormat("pt-BR");
export const formatInt = (n: number): string => nf.format(n);

/** `US$ 0,0123`: money with 4 decimals (model calls cost fractions of a cent). */
export function formatUsd(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes} min ${String(rest).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes - hours * 60).padStart(2, "0")} min`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `18/11/2026 14:03:22` in local time. */
export function formatDateTime(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${formatClock(date)}`;
}

/** `14:03:22` in local time. */
export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `14:03:22.123` in local time. */
export function formatClockMs(date: Date): string {
  return `${formatClock(date)}.${pad(date.getMilliseconds(), 3)}`;
}

/** One line: newlines folded, cut at `max` characters with an ellipsis. */
export function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** The first `lines` non-empty lines of `text`, each cut at `width`, plus how many were left out. */
export function firstLines(
  text: string,
  lines = 5,
  width = 140,
): { shown: string[]; more: number } {
  const all = text.split("\n").filter((l) => l.trim() !== "");
  const shown = all
    .slice(0, lines)
    .map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
  return { shown, more: Math.max(0, all.length - lines) };
}

export function indent(text: string, prefix: string): string[] {
  return text.split("\n").map((l) => (l === "" ? prefix.trimEnd() : `${prefix}${l}`));
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const LEVEL_PT: Record<string, string> = {
  read: "leitura",
  write_reversible: "escrita reversível",
  external_irreversible: "externa ou irreversível",
};

export const levelPt = (level: string): string => LEVEL_PT[level] ?? level;

export const SOURCE_PT: Record<string, string> = {
  rule: "regra sua",
  reviewer: "revisão automática",
  default: "o nível de risco",
};
