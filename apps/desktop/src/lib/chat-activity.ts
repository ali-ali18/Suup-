import type { PlanStep, Run, RunEvent } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";
import { toolCategory } from "../data/approval-text.js";
import { currentStep, runningTool } from "../data/derive.js";

// O avatar vivo do chat (docs/DESIGN.md §3, "O bot trabalhando"): o que a execução aberta está
// fazendo AGORA, num conjunto fechado de atividades declaradas, e a expressão de cada uma numa
// tabela exata. A atividade vem só do que o servidor manda (o status da execução e os eventos dela:
// uma chamada de ferramenta sem resultado é a ferramenta rodando); a categoria da ferramenta vem do
// nome EXATO dela (`toolCategory`), nunca do texto (docs/REGRAS.md §1).

/** Tudo o que o avatar do chat pode estar fazendo. */
export const CHAT_ACTIVITIES = [
  /** Na fila, ou retomando depois de uma resposta. */
  "queued",
  /** Esperando o modelo (pensando, escrevendo a resposta). */
  "thinking",
  /** Rodando um comando no terminal. */
  "terminal",
  /** Lendo ou mexendo em arquivos. */
  "files",
  /** Buscando na web ou lendo uma página. */
  "web",
  /** Consultando a memória. */
  "memory",
  /** Outra ferramenta (conector, equipe, rotina…). */
  "tool",
  /** Esperando você aprovar uma ação. */
  "approval",
  /** Esperando a sua resposta a uma pergunta. */
  "question",
  /** Você pausou a execução. */
  "paused",
  /** Terminou (só enquanto o avatar sai). */
  "done",
  /** Falhou ou foi cancelada (só enquanto o avatar sai). */
  "failed",
] as const;

export type ChatActivity = (typeof CHAT_ACTIVITIES)[number];

/**
 * A expressão de cada atividade: um estado público do motor `@suup/avatar`. Nunca um em que o
 * corpo vira indicador (`BODY_MORPH_STATES`: os pontinhos de `thinking`, a órbita de `waiting`),
 * porque o rosto nunca vira indicador (§6); para pensar existe `pondering` (o rosto fica e os olhos
 * procuram para cima; no pixel, a pose "Pensando").
 */
export const ACTIVITY_AVATAR: Readonly<Record<ChatActivity, AvatarStateId>> = {
  queued: "pondering",
  thinking: "pondering",
  terminal: "coding",
  files: "reading",
  web: "reading",
  memory: "reading",
  tool: "working",
  approval: "asking",
  question: "asking",
  paused: "paused",
  done: "done",
  failed: "failed",
};

/** A frase curta e amigável de cada atividade (nada técnico: nem comando, nem caminho, nem nome interno). */
const ACTIVITY_PHRASE: Readonly<Record<Exclude<ChatActivity, "queued">, string>> = {
  thinking: "Pensando",
  terminal: "Rodando um comando",
  files: "Mexendo nos arquivos",
  web: "Procurando na web",
  memory: "Usando a memória",
  tool: "Trabalhando",
  approval: "Esperando a sua aprovação",
  question: "Esperando a sua resposta",
  paused: "Pausado",
  done: "Pronto",
  failed: "Parou",
};

/** O que a categoria declarada de uma ferramenta é, como atividade (tabela exata pelo ícone). */
const CATEGORY_ACTIVITY: Readonly<Record<string, ChatActivity>> = {
  terminal: "terminal",
  file: "files",
  web: "web",
  memory: "memory",
};

/**
 * A atividade da execução aberta, ou `null` quando o avatar não aparece: sem execução, ou numa
 * execução parada até o retorno que o bot marcou (`waiting_timer`, sem marca nenhuma; §1).
 */
export function chatActivityOf(
  run: Pick<Run, "status" | "paused"> | null,
  events: readonly RunEvent[],
): ChatActivity | null {
  if (run === null) return null;
  switch (run.status) {
    case "queued":
      return run.paused ? "paused" : "queued";
    case "running": {
      if (run.paused) return "paused";
      const tool = runningTool(events);
      if (tool === undefined) return "thinking";
      return CATEGORY_ACTIVITY[toolCategory(tool).icon] ?? "tool";
    }
    case "waiting_approval":
      return "approval";
    case "waiting_user":
      return "question";
    case "done":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
    case "waiting_timer":
      return null;
  }
}

/**
 * A frase ao lado do avatar: a da atividade; pensando com um plano de vários passos, o passo
 * (o título é do bot); na fila, "Retomando" para uma execução que já tinha começado.
 */
export function activityPhrase(
  activity: ChatActivity,
  run: Pick<Run, "startedAt"> | null,
  plan: readonly PlanStep[],
): string {
  if (activity === "queued") return run?.startedAt != null ? "Retomando" : "Na fila";
  if (activity === "thinking") {
    const step = currentStep(plan);
    if (step !== undefined && plan.length > 1) {
      return `Passo ${plan.indexOf(step) + 1} de ${plan.length} · ${clip(step.title, 60)}`;
    }
  }
  return ACTIVITY_PHRASE[activity];
}

/** Uma linha de no máximo `max` caracteres (o passo do plano, que é texto do bot). */
function clip(text: string, max: number): string {
  const flat = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
