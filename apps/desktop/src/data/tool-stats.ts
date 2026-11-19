import type { RunEvent } from "@suup/api";

// The measurement of the tool definitions of a run, read from its events (inspector, read-only): how
// the connector tools were offered (`tool_catalog`, once per run) and what the definitions of each
// model request cost (`toolStats` of `model_request`, estimated). Nothing here measures anything.

export interface RequestToolStats {
  seq: number;
  /** `agent`, `review`... (the request's own purpose; missing means the agent). */
  purpose: string;
  definitions: number;
  deferred: number;
  estimatedTokens: number;
  loadedTokens: number;
}

export type CatalogMode = "direct" | "hosted" | "client" | "meta";

export interface CatalogInfo {
  mode: CatalogMode;
  /** The tools granted to the bot and what their definitions would cost, estimated. */
  connectorTools: number;
  definitionTokens: number;
  /** How many were kept out of the context (empty with `direct`). */
  deferred: number;
}

/** How a run offers the connector tools, in the words of the screen. */
export const CATALOG_LABEL: Record<CatalogMode, string> = {
  direct: "direto",
  hosted: "pesquisa nativa",
  client: "pesquisa nativa",
  meta: "pesquisa por índice",
};

/** One line saying what each mode means (from docs/CONECTORES.md). */
export const CATALOG_DETAIL: Record<CatalogMode, string> = {
  direct: "Todas as definições vão em todo pedido.",
  hosted: "O provedor pesquisa as definições adiadas.",
  client: "A pesquisa é do Suup e o provedor carrega as definições encontradas.",
  meta: "Um índice no prompt e as ferramentas search_tools e use_tool.",
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The requests of the run that carry `toolStats`, in order. Older runs have none: the list is empty. */
export function requestToolStats(events: readonly RunEvent[]): RequestToolStats[] {
  const out: RequestToolStats[] = [];
  for (const event of events) {
    if (event.type !== "model_request") continue;
    const stats = event.payload.toolStats;
    if (!isRecord(stats)) continue;
    const definitions = num(stats.definitions);
    const deferred = num(stats.deferred);
    const estimatedTokens = num(stats.estimatedTokens);
    const loadedTokens = num(stats.loadedTokens);
    if (
      definitions === undefined ||
      deferred === undefined ||
      estimatedTokens === undefined ||
      loadedTokens === undefined
    )
      continue;
    out.push({
      seq: event.seq,
      purpose: typeof event.payload.purpose === "string" ? event.payload.purpose : "agent",
      definitions,
      deferred,
      estimatedTokens,
      loadedTokens,
    });
  }
  return out;
}

const MODES: readonly string[] = ["direct", "hosted", "client", "meta"];

/** The run's `tool_catalog` (the first one: it is decided once), or `undefined` when the run had no connector tools. */
export function catalogOf(events: readonly RunEvent[]): CatalogInfo | undefined {
  const event = events.find((e) => e.type === "tool_catalog");
  if (event === undefined) return undefined;
  const mode = event.payload.mode;
  if (typeof mode !== "string" || !MODES.includes(mode)) return undefined;
  const deferred = event.payload.deferred;
  return {
    mode: mode as CatalogMode,
    connectorTools: num(event.payload.connectorTools) ?? 0,
    definitionTokens: num(event.payload.definitionTokens) ?? 0,
    deferred: Array.isArray(deferred) ? deferred.length : 0,
  };
}
