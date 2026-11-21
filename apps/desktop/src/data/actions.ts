import type { Approval, PlanStep, Run, RunEvent } from "@suup/api";
import { type CategoryIcon, NETWORK_TOOL, STATUS_LABEL, toolCategory } from "./approval-text.js";
import {
  CONTROL_TOOLS,
  currentStep,
  resolveToolCall,
  SEARCH_TOOLS,
  SILENT_TOOLS,
  toolLabel,
} from "./derive.js";

// What the bot DID, as the chat shows it: one card per tool call of a run, built from the run's
// events (`tool_call` + `tool_result`). A call that had an approval card is still ONE row: the
// approval (linked by the call id the approval carries) merges into it. The control tools (`plan`, `finish`, `escalate`) are not
// cards: the plan shows in the working indicator, and the other two become the bot's message.

export type ActionKind = "terminal" | "files" | "web" | "memory" | "other";
/** `stopped`: never executed (denied, expired or cancelled before it ran). */
export type ActionState = "running" | "done" | "failed" | "stopped";

type ConnectorRefs = readonly {
  name: string;
  tools?: readonly { name: string; tool: string }[] | null;
}[];

export interface ActionItem {
  callId: string;
  runId: string;
  name: string;
  kind: ActionKind;
  /** The bold word of the card, from `toolCategory`: "Terminal", "Arquivo", "Web", "Memória"... */
  kindLabel: string;
  /** The icon of the same category. */
  icon: CategoryIcon;
  /** What it did, in one line (for the collapsed card). */
  summary: string;
  /** What it is doing, in one line (for the working indicator). */
  doing: string;
  state: ActionState;
  args: Record<string, unknown>;
  /** The tool's result (its output, or its error). */
  output?: string;
  truncated: boolean;
  durationMs?: number;
  /** When the tool was called (ISO), to place the card among the messages. */
  startedAt: string;
  /** The approval card of this call, once decided (linked by call id). */
  approval?: Approval;
  /** The call was built from the approval alone: the events of its run are not loaded. */
  fromApproval?: true;
  /** A rule of the user let the call through with no card (`policy_checked`, allow, rule). */
  allowedByRule?: true;
  /**
   * A rule the user WROTE ("Nunca permitir") refused the call: no card, the bot got the reason back
   * as an error (`policy_checked`, deny, reviewer, with the rule's id). The row says so and is `stopped`.
   */
  blocked?: { writtenRuleId: string | null; reason: string };
}

const BLOCK_PREFIX = 'Bloqueado pela regra "';

/**
 * What a blocked call's row says after "Bloqueado pela regra ·": the text of the rule when it is
 * known, else the quoted text out of the reason the server gave (exact prefix and suffix, no pattern),
 * else the reason as it came.
 */
export function blockedRuleText(
  blocked: NonNullable<ActionItem["blocked"]>,
  rule?: { text: string },
): string {
  if (rule !== undefined) return rule.text;
  const { reason } = blocked;
  if (
    reason.startsWith(BLOCK_PREFIX) &&
    reason.endsWith('"') &&
    reason.length > BLOCK_PREFIX.length
  )
    return reason.slice(BLOCK_PREFIX.length, -1);
  return reason === "" ? "uma regra sua" : reason;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 40);
  }
};

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "list_files", "search_files"]);
const MEMORY_TOOLS = new Set(["remember", "recall", "forget", "search_conversations"]);

/**
 * The kind, the bold label and the two one-line descriptions of a tool call, in Portuguese, from the
 * tool's name and arguments: `summary` ("Editar a.ts") for the card, `doing` ("Editando a.ts") for
 * the indicator that says what the bot is doing now.
 */
export function describeAction(
  name: string,
  args: Record<string, unknown>,
  connectors: ConnectorRefs = [],
): Pick<ActionItem, "kind" | "kindLabel" | "icon" | "summary" | "doing"> {
  const category = toolCategory(name, connectors);
  const label = { kindLabel: category.label, icon: category.icon };
  const text = (key: string): string | undefined => {
    const value = str(args[key]);
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const files = (summary: string, doing: string) => ({
    kind: "files" as const,
    ...label,
    summary,
    doing,
  });
  const memory = (summary: string, doing: string) => ({
    kind: "memory" as const,
    ...label,
    summary,
    doing,
  });
  const path = text("path") === undefined ? undefined : clip(text("path") as string, 60);
  switch (name) {
    case "shell": {
      const command =
        text("command") === undefined ? undefined : clip(text("command") as string, 80);
      return {
        kind: "terminal",
        ...label,
        summary: command === undefined ? "Rodar um comando" : `Rodar o comando ${command}`,
        doing: command === undefined ? "Rodando um comando" : `Rodando o comando ${command}`,
      };
    }
    case "read_file":
      return files(
        path === undefined ? "Ler um arquivo" : `Ler ${path}`,
        path === undefined ? "Lendo um arquivo" : `Lendo ${path}`,
      );
    case "write_file":
      return files(
        path === undefined ? "Escrever um arquivo" : `Escrever ${path}`,
        path === undefined ? "Escrevendo um arquivo" : `Escrevendo ${path}`,
      );
    case "edit_file":
      return files(
        path === undefined ? "Editar um arquivo" : `Editar ${path}`,
        path === undefined ? "Editando um arquivo" : `Editando ${path}`,
      );
    case "list_files":
      return files(
        path === undefined ? "Listar arquivos" : `Listar arquivos em ${path}`,
        path === undefined ? "Listando arquivos" : `Listando arquivos em ${path}`,
      );
    case "search_files": {
      const pattern =
        text("pattern") === undefined ? undefined : clip(text("pattern") as string, 40);
      return files(
        pattern === undefined ? "Buscar nos arquivos" : `Buscar “${pattern}” nos arquivos`,
        pattern === undefined ? "Buscando nos arquivos" : `Buscando “${pattern}” nos arquivos`,
      );
    }
    case "web_fetch": {
      const where = text("url") === undefined ? undefined : host(text("url") as string);
      return {
        kind: "web",
        ...label,
        summary: where === undefined ? "Acessar uma página" : `Acessar ${where}`,
        doing: where === undefined ? "Acessando uma página" : `Acessando ${where}`,
      };
    }
    case NETWORK_TOOL: {
      const where = text("host") === undefined ? undefined : clip(text("host") as string, 60);
      return {
        kind: "other",
        ...label,
        summary: where === undefined ? "Acessar um host" : `Acessar ${where}`,
        doing: where === undefined ? "Pedindo acesso a um host" : `Pedindo acesso a ${where}`,
      };
    }
    case SEARCH_TOOLS: {
      const words = text("words") === undefined ? undefined : clip(text("words") as string, 40);
      const connector =
        text("connector") === undefined ? undefined : clip(text("connector") as string, 40);
      const what =
        words === undefined
          ? connector === undefined
            ? ""
            : ` do conector ${connector}`
          : ` “${words}”${connector === undefined ? "" : ` no conector ${connector}`}`;
      return {
        kind: "other",
        ...label,
        summary: `Procurar ferramentas${what}`,
        doing: `Procurando ferramentas${what}`,
      };
    }
    case "remember":
      return memory("Salvar na memória", "Salvando na memória");
    case "recall":
      return memory("Consultar a memória", "Consultando a memória");
    case "forget":
      return memory("Esquecer uma memória", "Esquecendo uma memória");
    case "search_conversations":
      return memory("Buscar nas conversas", "Buscando nas conversas");
    default:
      return {
        kind: "other",
        ...label,
        summary: `Usar ${toolLabel(name).toLowerCase()}`,
        doing: `Usando ${toolLabel(name).toLowerCase()}`,
      };
  }
}

export const isFileTool = (name: string): boolean => FILE_TOOLS.has(name);
export const isMemoryTool = (name: string): boolean => MEMORY_TOOLS.has(name);

/** One card per tool call of a run, in the order they were made; the result fills in when it arrives. */
export function actionsOf(
  runId: string,
  events: readonly RunEvent[],
  connectors: ConnectorRefs = [],
): ActionItem[] {
  const items: ActionItem[] = [];
  const byCall = new Map<string, ActionItem>();
  // The calls a rule of the user let through without a card.
  const byRule = new Set<string>();
  // The calls a written "never" rule refused.
  const blockedCalls = new Map<string, NonNullable<ActionItem["blocked"]>>();
  for (const event of events) {
    if (event.type !== "policy_checked") continue;
    const callId = str(event.payload.callId);
    if (callId === undefined) continue;
    if (event.payload.outcome === "allow" && event.payload.source === "rule") byRule.add(callId);
    else if (event.payload.outcome === "deny" && event.payload.source === "reviewer") {
      blockedCalls.set(callId, {
        writtenRuleId: str(event.payload.writtenRuleId) ?? null,
        reason: str(event.payload.reason) ?? "",
      });
    }
  }
  for (const event of events) {
    if (event.type === "tool_call") {
      const callId = str(event.payload.callId);
      const logged = str(event.payload.name);
      if (callId === undefined || logged === undefined) continue;
      // A call through `use_tool` is the REAL tool: its row is that tool's, never the wrapper's.
      const { name, args } = resolveToolCall(logged, event.payload.args);
      if (CONTROL_TOOLS.has(name) || SILENT_TOOLS.has(name)) continue;
      if (byCall.has(callId)) continue;
      const item: ActionItem = {
        callId,
        runId,
        name,
        ...describeAction(name, args, connectors),
        state: "running",
        args,
        truncated: false,
        startedAt: event.createdAt,
        ...(byRule.has(callId) ? { allowedByRule: true as const } : {}),
        ...(blockedCalls.has(callId)
          ? { blocked: blockedCalls.get(callId) as NonNullable<ActionItem["blocked"]> }
          : {}),
      };
      byCall.set(callId, item);
      items.push(item);
    } else if (event.type === "tool_result") {
      const item = byCall.get(str(event.payload.callId) ?? "");
      if (item === undefined) continue;
      // A refused call is not a failure of the tool: it never ran.
      item.state =
        item.blocked !== undefined ? "stopped" : event.payload.isError === true ? "failed" : "done";
      item.output = str(event.payload.content) ?? "";
      item.truncated = event.payload.truncated === true;
      if (typeof event.payload.durationMs === "number") item.durationMs = event.payload.durationMs;
    }
  }
  return items;
}

const asArgs = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * One row per tool call. The approval cards join the calls of the run by the call id the approval
 * carries (and its run), never by text: a decided approval merges INTO its call (the call keeps its
 * place and result, gains the decision, and a call that was never executed is `stopped`); a decided
 * approval whose call is not among `actions` (an older run) becomes a call of its own; a pending
 * approval stays a decision card (`pending`) and its call is not a row yet.
 */
/** An approval that DECLARES a message to another person reads as one in the chat (never guessed). */
function outboundLook(
  approval: Approval,
  connectors: ConnectorRefs,
): Partial<Pick<ActionItem, "kindLabel" | "icon">> {
  if (approval.outbound === null) return {};
  const category = toolCategory(approval.tool, connectors, true);
  return { kindLabel: category.label, icon: category.icon };
}

export function mergeApprovals(
  actions: readonly ActionItem[],
  approvals: readonly Approval[],
  connectors: ConnectorRefs = [],
): { calls: ActionItem[]; pending: Approval[] } {
  const key = (runId: string, callId: string) => `${runId}\u0000${callId}`;
  const byCall = new Map(approvals.map((a) => [key(a.runId, a.callId), a]));
  const used = new Set<string>();
  const calls: ActionItem[] = [];
  const pending: Approval[] = [];
  for (const action of actions) {
    const approval = byCall.get(key(action.runId, action.callId));
    if (approval === undefined) {
      calls.push(action);
      continue;
    }
    used.add(approval.id);
    if (approval.status === "pending") {
      pending.push(approval);
      continue;
    }
    // Denied, expired or cancelled: it never ran, whatever the log says about the refusal.
    const ran = approval.status === "approved";
    const { output: _output, durationMs: _duration, ...rest } = action;
    const look = outboundLook(approval, connectors);
    calls.push(
      ran
        ? { ...action, ...look, approval }
        : { ...rest, ...look, state: "stopped", truncated: false, approval },
    );
  }
  for (const approval of approvals) {
    if (used.has(approval.id)) continue;
    if (approval.status === "pending") {
      pending.push(approval);
      continue;
    }
    // A decided approval of a silent tool (saving or forgetting a memory) leaves no row either.
    if (SILENT_TOOLS.has(approval.tool)) continue;
    const args = asArgs(approval.args);
    calls.push({
      callId: approval.callId,
      runId: approval.runId,
      name: approval.tool,
      ...describeAction(approval.tool, args, connectors),
      ...outboundLook(approval, connectors),
      state: approval.status === "approved" ? "done" : "stopped",
      args,
      truncated: false,
      startedAt: approval.createdAt,
      approval,
      fromApproval: true,
    });
  }
  return { calls, pending };
}

/** How long a card waited, in the owner's words: "40 min", "5 h", "3 dias". */
export function waitedText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} dias`;
}

/**
 * The muted word before the summary of a call's row, in Portuguese, saying the decision and the
 * execution together ("Aprovado e concluído", "Recusado"). `undefined`: no approval, the row says
 * what the state says ("Rodando", "Concluído", "Falhou").
 */
export function callStateLabel(item: ActionItem): string | undefined {
  const { approval } = item;
  if (item.blocked !== undefined) return "Bloqueado pela regra";
  if (approval === undefined) return undefined;
  if (approval.status !== "approved") return STATUS_LABEL[approval.status] ?? approval.status;
  // Approved after waiting too long: the call did not run then (the bot asked again, or dropped it).
  if (approval.stale && approval.waitedMs !== null) {
    return `Aprovado depois de ${waitedText(approval.waitedMs)}`;
  }
  if (item.fromApproval === true) return "Aprovado";
  switch (item.state) {
    case "running":
      return "Aprovado, rodando";
    case "failed":
      return "Aprovado, mas falhou";
    default:
      return "Aprovado e concluído";
  }
}

export type ActionEntry =
  | { kind: "action"; item: ActionItem }
  /** Older finished cards folded into one row, "Mais N ações". */
  | { kind: "fold"; key: string; items: ActionItem[] };

/** How many of the latest cards stay visible before older finished ones fold. */
export const VISIBLE_ACTIONS = 3;

/**
 * Keeps long runs readable: of a group of consecutive cards, the latest `keep` always show; of the
 * older ones, the finished ones that follow each other fold into one row (a failed card stays where
 * it is, because a failure should not hide).
 */
export function foldActions(
  items: readonly ActionItem[],
  keep: number = VISIBLE_ACTIONS,
): ActionEntry[] {
  const older = items.slice(0, Math.max(0, items.length - keep));
  const latest = items.slice(older.length);
  const entries: ActionEntry[] = [];
  let group: ActionItem[] = [];
  const flush = () => {
    const first = group[0];
    if (first === undefined) return;
    entries.push(
      group.length === 1
        ? { kind: "action", item: first }
        : { kind: "fold", key: `fold:${first.callId}`, items: group },
    );
    group = [];
  };
  for (const item of older) {
    if (item.state === "done") group.push(item);
    else {
      flush();
      entries.push({ kind: "action", item });
    }
  }
  flush();
  for (const item of latest) entries.push({ kind: "action", item });
  return entries;
}

/**
 * The phrase of the working indicator, from the real state of the run: what the tool in flight is
 * doing, else the step of the plan, else "Pensando"; "Retomando" for a run put back after an answer.
 */
export function workingPhrase(
  run: Pick<Run, "status" | "paused" | "startedAt">,
  actions: readonly ActionItem[],
  plan: readonly PlanStep[],
): string {
  if (run.paused) return "Pausado";
  if (run.status === "queued") return run.startedAt !== null ? "Retomando" : "Na fila";
  const running = [...actions].reverse().find((a) => a.state === "running");
  if (running !== undefined) return running.doing;
  const step = currentStep(plan);
  if (step !== undefined && plan.length > 1) {
    return `Passo ${plan.indexOf(step) + 1} de ${plan.length} · ${clip(step.title, 60)}`;
  }
  return "Pensando";
}
