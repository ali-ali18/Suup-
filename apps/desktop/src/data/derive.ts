import type { PlanStep, Run, RunEvent, RunStatus } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";
import { avatarStateOf } from "../lib/avatar-state.js";

// What the screen shows, derived from what the server said (run status + the run's events), per
// docs/FRONTEND.md sections 4, 5 and 11. No business rule lives here: it only chooses words and
// pictures. Pure functions, table-tested.

/** The chips of the design (Figma "v2/Selo de status"). */
export type ChipKind =
  | "working"
  | "thinking"
  | "doubt"
  | "permission"
  | "resuming"
  | "queued"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

/** How the bot's avatar reacts (FRONTEND.md section 11). */
export type Reaction =
  | "idle"
  | "thinking"
  | "working"
  | "doubt"
  | "permission"
  | "done"
  | "scolded"
  | "failed"
  | "paused";

export interface RunDisplay {
  chip: ChipKind | null;
  label: string;
  reaction: Reaction;
  /** O estado do avatar do bot (`avatarStateOf`). */
  avatar: AvatarStateId;
  /** The run is in the foreground: working, waiting for the user, or paused. */
  active: boolean;
  /** The tool being used right now (`working`), for the label. */
  tool?: string;
}

export const CHIP_LABEL: Record<ChipKind, string> = {
  working: "Trabalhando",
  thinking: "Pensando",
  doubt: "Com dúvida",
  permission: "Pedindo permissão",
  resuming: "Retomando",
  queued: "Na fila",
  paused: "Pausado",
  done: "Concluiu",
  failed: "Falhou",
  cancelled: "Cancelada",
};

export const TOOL_LABEL: Record<string, string> = {
  shell: "Terminal",
  read_file: "Ler arquivo",
  write_file: "Escrever arquivo",
  edit_file: "Editar arquivo",
  list_files: "Listar arquivos",
  search_files: "Buscar nos arquivos",
  web_fetch: "Acessar página",
  remember: "Salvar na memória",
  recall: "Consultar memória",
  forget: "Esquecer",
  search_conversations: "Buscar nas conversas",
};

/** The control tools are not cards: `request_secret` is the secure form, not an "action". */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "plan",
  "finish",
  "escalate",
  "request_secret",
]);

export const toolLabel = (name: string): string => TOOL_LABEL[name] ?? name;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Events that say what the bot is doing, leaving out bookkeeping and the reviewer's own calls. */
function isActivity(event: RunEvent): boolean {
  if (event.type === "model_request" || event.type === "model_response") {
    return str(event.payload.purpose) === undefined || event.payload.purpose === "agent";
  }
  return [
    "tool_call",
    "tool_result",
    "finish_attempt",
    "review",
    "review_evidence",
    "review_reprompt",
    "escalated",
    "plan_updated",
    "user_message",
    "nudge",
  ].includes(event.type);
}

/** A tool call whose result has not arrived: the tool is running. */
export function runningTool(events: readonly RunEvent[]): string | undefined {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_result") {
      const callId = str(event.payload.callId);
      if (callId !== undefined) resolved.add(callId);
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as RunEvent;
    if (event.type !== "tool_call") continue;
    const callId = str(event.payload.callId);
    const name = str(event.payload.name);
    if (callId === undefined || name === undefined || CONTROL_TOOLS.has(name)) continue;
    if (!resolved.has(callId)) return name;
  }
  return undefined;
}

/** The last thing that happened, among the events that matter, for the avatar's reaction. */
function lastActivity(events: readonly RunEvent[]): RunEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as RunEvent;
    if (isActivity(event)) return event;
  }
  return undefined;
}

/**
 * Display state of a run. `events` are the run's events in `seq` order (may be empty: only the
 * run's own status is then used, which is all a list of bots has).
 *
 * - `queued` with `paused`: "Pausado". `queued` after the run already started (it waited for the
 *   user and the answer put it back, or a worker restarted it): "Retomando". `queued` before ever
 *   starting: "Na fila". A run is never required to be seen in `queued`: every other state is
 *   derived from the status alone.
 * - `running`: "Trabalhando" while a tool call has no result yet, otherwise "Pensando".
 */
export function deriveRunDisplay(
  run: Pick<Run, "status" | "paused" | "startedAt"> | null,
  events: readonly RunEvent[] = [],
): RunDisplay {
  const display = displayOfRun(run, events);
  return { ...display, avatar: avatarStateOf(run, display.tool !== undefined) };
}

function displayOfRun(
  run: Pick<Run, "status" | "paused" | "startedAt"> | null,
  events: readonly RunEvent[],
): Omit<RunDisplay, "avatar"> {
  if (run === null) return { chip: null, label: "", reaction: "idle", active: false };
  const display = (
    chip: ChipKind | null,
    reaction: Reaction,
    active: boolean,
    extra: Partial<Omit<RunDisplay, "avatar">> = {},
  ): Omit<RunDisplay, "avatar"> => ({
    chip,
    label: chip === null ? "" : CHIP_LABEL[chip],
    reaction,
    active,
    ...extra,
  });

  const status: RunStatus = run.status;
  switch (status) {
    case "done":
      return display("done", "done", false);
    case "failed":
      return display("failed", "failed", false);
    case "cancelled":
      return display("cancelled", "idle", false);
    case "waiting_user":
      return display("doubt", "doubt", true);
    case "waiting_approval":
      return display("permission", "permission", true);
    case "queued":
      if (run.paused) return display("paused", "paused", true);
      if (run.startedAt !== null) return display("resuming", "thinking", true);
      return display("queued", "thinking", true);
    case "running": {
      if (run.paused) return display("paused", "paused", true);
      const last = lastActivity(events);
      const tool = runningTool(events);
      if (tool !== undefined) return display("working", "working", true, { tool });
      if (last?.type === "review" && last.payload.verdict === "reject") {
        return display("thinking", "scolded", true);
      }
      if (last?.type === "finish_attempt" && last.payload.accepted === false) {
        return display("thinking", "scolded", true);
      }
      return display("thinking", "thinking", true);
    }
  }
}

/** The avatar's reaction once a run is over, for a short celebration (accepted finish). */
export function acceptedFinish(events: readonly RunEvent[]): boolean {
  return events.some((e) => e.type === "finish_attempt" && e.payload.accepted === true);
}

// ----------------------------------------------------------------- timeline

/** The latest plan: the run's own (kept current by `run.updated`), else the last `plan_updated`. */
export function planOf(run: Pick<Run, "plan"> | null, events: readonly RunEvent[]): PlanStep[] {
  if (run !== null && run.plan.length > 0) return run.plan;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as RunEvent;
    if (event.type === "plan_updated" && Array.isArray(event.payload.plan)) {
      return event.payload.plan as PlanStep[];
    }
  }
  return [];
}

/** The plan step being worked on now, if any. */
export const currentStep = (plan: readonly PlanStep[]): PlanStep | undefined =>
  plan.find((s) => s.status === "in_progress");

export interface Timeline {
  context?: string;
  notices: { seq: number; text: string }[];
  /** Replies of the user read by the bot, for the "lida pelo bot" mark. */
  readUserMessages: string[];
}

/** Discreet notices of the run: memory loaded, compaction, nudges, model errors, rejected finish. */
export function timelineNotices(events: readonly RunEvent[]): Timeline {
  const notices: Timeline["notices"] = [];
  let context: string | undefined;
  const readUserMessages: string[] = [];
  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case "context_loaded": {
        const rules = Array.isArray(p.rules) ? p.rules.length : 0;
        const profile = Array.isArray(p.profile) ? p.profile.length : 0;
        const history =
          typeof p.history === "number"
            ? p.history
            : Array.isArray(p.history)
              ? p.history.length
              : 0;
        context = `${rules} ${rules === 1 ? "regra" : "regras"}, ${profile} ${profile === 1 ? "fato do perfil" : "fatos do perfil"}, ${history} ${history === 1 ? "mensagem anterior" : "mensagens anteriores"}`;
        break;
      }
      case "compacted":
        notices.push({ seq: event.seq, text: "Histórico resumido para caber no contexto." });
        break;
      case "nudge":
        notices.push({ seq: event.seq, text: "O Suup pediu ao bot que continuasse." });
        break;
      case "model_error":
        if (str(p.purpose) === undefined || p.purpose === "agent") {
          notices.push({
            seq: event.seq,
            text:
              p.retryable === true
                ? "Tentando de novo…"
                : `Erro do modelo: ${str(p.message) ?? "desconhecido"}`,
          });
        }
        break;
      case "finish_attempt":
        if (p.accepted === false) {
          const reasons = Array.isArray(p.rejectionReasons) ? p.rejectionReasons.length : 0;
          notices.push({
            seq: event.seq,
            text: `Conclusão recusada${reasons > 0 ? ` (${reasons} ${reasons === 1 ? "motivo" : "motivos"})` : ""}.`,
          });
        }
        break;
      case "review":
        if (p.verdict === "reject") {
          notices.push({ seq: event.seq, text: "O revisor recusou a conclusão." });
        } else if (p.verdict === "unverified") {
          notices.push({
            seq: event.seq,
            text:
              p.namedNothing === true
                ? "O revisor não conseguiu verificar a conclusão e não nomeou o que lhe faltou."
                : "O revisor não conseguiu verificar a conclusão.",
          });
        }
        break;
      case "user_message":
        if (typeof p.text === "string") readUserMessages.push(p.text);
        break;
      default:
        break;
    }
  }
  return { ...(context === undefined ? {} : { context }), notices, readUserMessages };
}

// ------------------------------------------------------------ failure origin

export const ORIGIN_TAG: Record<string, string> = {
  provider: "Provedor",
  model: "Modelo",
  tool: "Ferramenta",
  harness: "Suup",
  limit: "Limite",
  approval: "Aprovação",
  user: "Você",
};

/** The plain-language explanation of each failure origin (FRONTEND.md section 4). */
export const ORIGIN_EXPLANATION: Record<string, string> = {
  provider:
    "A API do modelo falhou (rede, chave ou limite de uso). O problema não está no bot nem no Suup.",
  model: "O modelo se comportou mal: recusou, parou sem concluir ou ficou em laço.",
  tool: "Uma ferramenta falhou ao ser usada pelo bot.",
  harness: "Houve um defeito do próprio Suup. Os detalhes do diagnóstico ajudam a corrigir.",
  limit: "Um limite configurado foi atingido: número de turnos, custo ou tempo.",
  approval: "Uma ação precisava de aprovação e foi negada ou expirou.",
  user: "A execução foi encerrada a seu pedido.",
};

export function failureOriginLabel(origin: string | null): string {
  return origin === null ? "Suup" : (ORIGIN_TAG[origin] ?? origin);
}

// -------------------------------------------------------------------- usage

/** `"0.034100"` -> `"US$ 0,03"`: money stays text on the wire; only the display rounds it. */
export function formatCost(costUsd: string): string {
  const value = Number(costUsd);
  if (!Number.isFinite(value)) return "US$ 0,00";
  const small = value > 0 && value < 0.01;
  const text = value.toLocaleString("pt-BR", {
    minimumFractionDigits: small ? 4 : 2,
    maximumFractionDigits: small ? 4 : 2,
  });
  return `US$ ${text}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** The line that replaces a failed run: what happened, in plain language, by origin. */
export const FAILURE_LINE: Record<string, string> = {
  provider: "o provedor do modelo falhou",
  model: "o modelo desistiu ou se perdeu",
  tool: "uma ferramenta falhou",
  harness: "houve um erro interno do Suup",
  limit: "um limite foi atingido (turnos, custo ou tempo)",
  approval: "uma aprovação foi negada",
  user: "a execução foi encerrada a seu pedido",
};

export function failureLine(origin: string | null): string {
  return `Não consegui terminar: ${FAILURE_LINE[origin ?? "harness"] ?? "houve uma falha"}`;
}
