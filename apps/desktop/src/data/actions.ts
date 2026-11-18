import type { PlanStep, Run, RunEvent } from "@suup/api";
import { CONTROL_TOOLS, currentStep, toolLabel } from "./derive.js";

// What the bot DID, as the chat shows it: one card per tool call of a run, built from the run's
// events (`tool_call` + `tool_result`). The control tools (`plan`, `finish`, `escalate`) are not
// cards: the plan shows in the working indicator, and the other two become the bot's message.

export type ActionKind = "terminal" | "files" | "web" | "memory" | "other";
export type ActionState = "running" | "done" | "failed";

export interface ActionItem {
  callId: string;
  runId: string;
  name: string;
  kind: ActionKind;
  /** The bold word of the card: "Terminal", "Arquivos", "Web", "Memória"... */
  kindLabel: string;
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
): Pick<ActionItem, "kind" | "kindLabel" | "summary" | "doing"> {
  const text = (key: string): string | undefined => {
    const value = str(args[key]);
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const files = (summary: string, doing: string) => ({
    kind: "files" as const,
    kindLabel: "Arquivos",
    summary,
    doing,
  });
  const memory = (summary: string, doing: string) => ({
    kind: "memory" as const,
    kindLabel: "Memória",
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
        kindLabel: "Terminal",
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
        kindLabel: "Web",
        summary: where === undefined ? "Acessar uma página" : `Acessar ${where}`,
        doing: where === undefined ? "Acessando uma página" : `Acessando ${where}`,
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
        kindLabel: toolLabel(name),
        summary: `Usar ${toolLabel(name).toLowerCase()}`,
        doing: `Usando ${toolLabel(name).toLowerCase()}`,
      };
  }
}

export const isFileTool = (name: string): boolean => FILE_TOOLS.has(name);
export const isMemoryTool = (name: string): boolean => MEMORY_TOOLS.has(name);

/** One card per tool call of a run, in the order they were made; the result fills in when it arrives. */
export function actionsOf(runId: string, events: readonly RunEvent[]): ActionItem[] {
  const items: ActionItem[] = [];
  const byCall = new Map<string, ActionItem>();
  for (const event of events) {
    if (event.type === "tool_call") {
      const callId = str(event.payload.callId);
      const name = str(event.payload.name);
      if (callId === undefined || name === undefined || CONTROL_TOOLS.has(name)) continue;
      if (byCall.has(callId)) continue;
      const args =
        typeof event.payload.args === "object" && event.payload.args !== null
          ? (event.payload.args as Record<string, unknown>)
          : {};
      const item: ActionItem = {
        callId,
        runId,
        name,
        ...describeAction(name, args),
        state: "running",
        args,
        truncated: false,
        startedAt: event.createdAt,
      };
      byCall.set(callId, item);
      items.push(item);
    } else if (event.type === "tool_result") {
      const item = byCall.get(str(event.payload.callId) ?? "");
      if (item === undefined) continue;
      item.state = event.payload.isError === true ? "failed" : "done";
      item.output = str(event.payload.content) ?? "";
      item.truncated = event.payload.truncated === true;
      if (typeof event.payload.durationMs === "number") item.durationMs = event.payload.durationMs;
    }
  }
  return items;
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
