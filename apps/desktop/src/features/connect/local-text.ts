import type { LocalStage, LocalStatus, NoIsolationReason } from "../../lib/platform.js";

/** What the embedded server is doing, in words (the stage is a code from the shell, never text). */
export const STAGE_TEXT: Record<LocalStage, string> = {
  database: "Preparando o banco de dados…",
  migrations: "Atualizando o banco de dados…",
  machine: "Preparando a máquina dos bots (só na primeira vez, pode levar alguns minutos)…",
  server: "Iniciando o servidor…",
};

/** Why the bots' machine is not isolated, as one sentence. */
export const NO_ISOLATION_TEXT: Record<NoIsolationReason, string> = {
  docker_missing: "Abra o Docker Desktop (ou instale) para os bots trabalharem isolados.",
  gateway_unreachable: "O Docker está aberto, mas o isolamento dos bots não começou.",
  image_failed: "Não deu para preparar a máquina isolada dos bots.",
  network_failed: "Não deu para preparar a rede isolada dos bots.",
};

/** The standing warning when the bots run on this computer itself. */
export const NO_ISOLATION_WARNING =
  "Sem isolamento, os comandos dos bots rodam diretamente neste computador: use só com tarefas e dados em que você confia.";

/** The line that says where the bots work: "isolada (Docker)", or the reason it is not. */
export function machineLine(status: LocalStatus): string {
  const iso = status.isolation;
  if (iso === null) return "Ainda não verificada.";
  if (iso.mode === "docker") return "Isolada (Docker)";
  return iso.reason === null
    ? "Sem isolamento (neste computador)."
    : `Sem isolamento: ${NO_ISOLATION_TEXT[iso.reason]}`;
}
