// Owns how a run offers the tools of its connectors when there are many of them (research:
// docs/pesquisas/fase-3-muitas-ferramentas-mcp.md). Four ways, decided ONCE per run and written to
// the log (`tool_catalog`), so every request of the run has the same tools and the cache holds:
//
//   direct  every definition goes in every request (few tools, small definitions);
//   hosted  the provider's own deferred loading + a search the PROVIDER runs (bm25, or a regex the
//           MODEL writes at run time; the harness has no pattern of its own in it);
//   client  the provider's deferred loading + `search_tools`, a search the HARNESS runs that names
//           the tools to load (the answer carries `tool_reference`s);
//   meta    no provider support: a short index in the system prompt and two tools,
//           `search_tools` (the full definitions of what matches) and `use_tool` (call one by name).
//
// This module is pure: it decides, builds the index, ranks a search and checks arguments. It never
// executes a tool and never decides permissions: a deferred tool is reached only through the same
// gate and registry as any other (see `tool-search-calls.ts`). No regular expressions: words are
// split by classifying characters, and a match is an exact word in common.
import { z } from "zod";
import type { ToolCatalog, ToolSearchMode, ToolStats } from "../events.js";
import type { JsonObject } from "../messages.js";
import type { NativeToolSearch, ProviderCapabilities, ToolSpec } from "../provider.js";

export const SEARCH_TOOL_NAME = "search_tools";
export const USE_TOOL_NAME = "use_tool";

/** One connector tool the bot may use, as the runtime describes it for the search. */
export interface ToolSearchCandidate {
  /** The name in the registry (what the model calls). */
  name: string;
  /** The connector it belongs to. */
  group: string;
  /** What the server says it does (cleaned and bounded; untrusted). */
  summary: string;
}

export interface ToolSearchSettings {
  /** Defer when the bot has at least this many connector tools... */
  minTools: number;
  /** ...or when their definitions are estimated at least this many tokens. */
  minDefinitionTokens: number;
  /** An index longer than this many characters is replaced by one line per connector. */
  maxIndexChars: number;
}

export const DEFAULT_TOOL_SEARCH: ToolSearchSettings = {
  minTools: 10,
  minDefinitionTokens: 10_000,
  maxIndexChars: 6_000,
};

/** What the loop is given to decide with. */
export interface ToolSearchSetup {
  settings: ToolSearchSettings;
  /** The connector tools granted to the bot (in registry order). */
  candidates: readonly ToolSearchCandidate[];
  /** The native search the configuration declares for the model (never guessed from its id). */
  native?: NativeToolSearch | undefined;
}

/** A replay hands back what the recording decided instead of deciding again. */
export type ToolSearchDeps = ToolSearchSetup | { replayOf: ToolCatalog };

/** Characters per token of the estimate (a simple one, on purpose). */
const CHARS_PER_TOKEN = 4;

export function estimateSpecTokens(spec: ToolSpec): number {
  const chars =
    spec.name.length + spec.description.length + (JSON.stringify(spec.inputSchema)?.length ?? 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The size of the definitions of one request. `deferred` ones are sent but do not load. */
export function toolDefinitionStats(tools: readonly ToolSpec[]): ToolStats {
  let estimatedTokens = 0;
  let loadedTokens = 0;
  let deferred = 0;
  for (const spec of tools) {
    const cost = estimateSpecTokens(spec);
    estimatedTokens += cost;
    if (spec.deferLoading === true) deferred += 1;
    else loadedTokens += cost;
  }
  return { definitions: tools.length, deferred, estimatedTokens, loadedTokens };
}

/**
 * Decides how the connector tools are offered. `specs` are the definitions of the candidates (the
 * registry's); a candidate without a spec is left out. Pure: the same inputs, the same catalog.
 */
export function planToolSearch(
  setup: ToolSearchSetup,
  specs: ReadonlyMap<string, ToolSpec>,
  capabilities: Pick<ProviderCapabilities, "toolSearch">,
): ToolCatalog {
  const entries = setup.candidates.flatMap((c) => {
    const spec = specs.get(c.name);
    return spec === undefined ? [] : [{ ...c, spec }];
  });
  const definitionTokens = entries.reduce((sum, e) => sum + estimateSpecTokens(e.spec), 0);
  const { settings } = setup;
  const base = {
    settings: { minTools: settings.minTools, minDefinitionTokens: settings.minDefinitionTokens },
    connectorTools: entries.length,
    definitionTokens,
  };
  const defer =
    entries.length >= settings.minTools || definitionTokens >= settings.minDefinitionTokens;
  if (entries.length === 0 || !defer) return { mode: "direct", ...base, deferred: [] };

  const native = setup.native;
  const nativeOk = native !== undefined && capabilities.toolSearch?.includes(native) === true;
  const mode: ToolSearchMode = !nativeOk ? "meta" : native === "client" ? "client" : "hosted";
  const deferred = entries.map((e) => ({
    name: e.name,
    group: e.group,
    summary: e.summary,
    spec: mode === "meta" ? e.spec : { ...e.spec, deferLoading: true as const },
  }));
  return {
    mode,
    ...(mode === "hosted" && native !== undefined && native !== "client"
      ? { variant: native }
      : {}),
    ...base,
    deferred,
    index: buildIndex(mode, deferred, settings.maxIndexChars),
  };
}

// ---------------------------------------------------------------------------------------------
// The index (a section of the system prompt)

const FIRST_SENTENCE_MAX = 110;

/** Whether the character ends a sentence when a space or the end of the text follows it. */
function endsSentence(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?";
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/**
 * The first sentence of a description, cut by length: up to the first `.`, `!` or `?` that is
 * followed by a space (or ends the text), or the first line break, whichever comes first, and at
 * most `max` characters. A plain scan of characters; it does not try to understand the text.
 */
export function firstSentence(text: string, max = FIRST_SENTENCE_MAX): string {
  const flat = text.trim();
  let end = flat.length;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i] as string;
    if (
      ch === "\n" ||
      ch === "\r" ||
      (endsSentence(ch) && (i + 1 === flat.length || isSpace(flat[i + 1])))
    ) {
      end = ch === "\n" || ch === "\r" ? i : i + 1;
      break;
    }
  }
  const sentence = flat.slice(0, end).trim();
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max - 1).trimEnd()}…`;
}

function connectorsOf(deferred: ToolCatalog["deferred"]): { group: string; count: number }[] {
  const out: { group: string; count: number }[] = [];
  for (const d of deferred) {
    const last = out.find((o) => o.group === d.group);
    if (last === undefined) out.push({ group: d.group, count: 1 });
    else last.count += 1;
  }
  return out;
}

/** The section of the system prompt that says what can be searched. Fixed for the whole run. */
export function buildIndex(
  mode: ToolSearchMode,
  deferred: ToolCatalog["deferred"],
  maxChars: number,
): string {
  const connectors = connectorsOf(deferred);
  const perConnector = connectors.map((c) => `- ${c.group}: ${c.count} tool(s)`);
  if (mode === "hosted") {
    return [
      "## Connector tools",
      "",
      "Tools of external connectors are not loaded: their definitions are found with the tool search (describe what you need in a short query). Connectors available:",
      "",
      ...perConnector,
    ].join("\n");
  }
  if (mode === "client") {
    return [
      "## Connector tools",
      "",
      `Tools of external connectors are not loaded. Call \`${SEARCH_TOOL_NAME}\` (by connector name and/or words) to load the ones you need; after it answers you can call them like any other tool. Connectors available:`,
      "",
      ...perConnector,
    ].join("\n");
  }
  const intro = [
    "## Connector tools",
    "",
    `You may use tools of external connectors, but their definitions are not loaded. To use one: call \`${SEARCH_TOOL_NAME}\` (by connector name and/or words) to get the full definitions, then call \`${USE_TOOL_NAME}\` with \`tool\` (the exact name) and \`arguments\` (an object that follows the definition). The harness checks the arguments against the real definition and asks the user for approval exactly as it would for a direct call. Only the tools listed here exist for you.`,
    "",
  ];
  const lines = deferred.map((d) => {
    const hint = firstSentence(d.summary);
    return hint === "" ? `- ${d.name}` : `- ${d.name}: ${hint}`;
  });
  const full = [...intro, "Tools:", ...lines].join("\n");
  if (full.length <= maxChars) return full;
  return [
    ...intro,
    `The list is long, so it is grouped by connector. Call \`${SEARCH_TOOL_NAME}\` with \`connector\` to list the tools of one:`,
    "",
    ...perConnector,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The search (no regular expressions)

/** A character that belongs to a word: a digit or a letter of any script. */
function isWordChar(ch: string): boolean {
  if (ch >= "0" && ch <= "9") return true;
  if (ch.toLowerCase() !== ch.toUpperCase()) return true; // a cased letter (Latin, Greek, Cyrillic...)
  return ch.charCodeAt(0) >= 0x3040 && !isWordBreakSymbol(ch); // scripts without case (CJK, Hangul...)
}

/** Punctuation and symbols above the Latin range that are not part of a word. */
function isWordBreakSymbol(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x2000 && code <= 0x2bff) || // general punctuation, arrows, math, box drawing...
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0xff00 && code <= 0xff0f) // some full-width punctuation
  );
}

/** Lowercased words of a text: runs of word characters, split at everything else. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text.toLowerCase()) {
    if (isWordChar(ch)) current += ch;
    else if (current !== "") {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out;
}

function propertyNames(schema: JsonObject): string[] {
  const props = schema.properties;
  return typeof props === "object" && props !== null && !Array.isArray(props)
    ? Object.keys(props)
    : [];
}

export interface SearchQuery {
  /** Only the tools of this connector (compared exactly, lowercased). */
  connector?: string | undefined;
  /** Free words; a tool matches by the words it has in common with these. */
  words?: string | undefined;
  /** How many full definitions to return (1 to `MAX_SEARCH_RESULTS`). */
  limit?: number | undefined;
}

export const DEFAULT_SEARCH_RESULTS = 5;
export const MAX_SEARCH_RESULTS = 10;

export interface SearchOutcome {
  /** The best matches, at most `limit`. */
  matches: ToolCatalog["deferred"];
  /** More tools matched than `limit`. */
  more: ToolCatalog["deferred"];
}

/**
 * Ranks the deferred tools for a query: the connector filter is an exact comparison; the words
 * score a tool by how many DISTINCT query words appear as words of its name, connector, description
 * or argument names. No stemming, no synonyms: the model reads the result and makes the choice.
 * Ties keep the order of the catalog, so the same query always gives the same answer.
 */
export function searchCatalog(
  deferred: ToolCatalog["deferred"],
  query: SearchQuery,
): SearchOutcome {
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? DEFAULT_SEARCH_RESULTS)),
    MAX_SEARCH_RESULTS,
  );
  const connector = query.connector?.trim().toLowerCase();
  const pool =
    connector === undefined || connector === ""
      ? deferred
      : deferred.filter((d) => d.group.toLowerCase() === connector);
  const wanted = [...new Set(wordsOf(query.words ?? ""))];
  let ranked: ToolCatalog["deferred"];
  if (wanted.length === 0) {
    ranked = pool;
  } else {
    const scored = pool.map((d, order) => {
      const have = new Set([
        ...wordsOf(d.name),
        ...wordsOf(d.group),
        ...wordsOf(d.summary),
        ...propertyNames(d.spec.inputSchema).flatMap(wordsOf),
      ]);
      return { d, order, score: wanted.filter((w) => have.has(w)).length };
    });
    ranked = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((s) => s.d);
  }
  return { matches: ranked.slice(0, limit), more: ranked.slice(limit) };
}

// ---------------------------------------------------------------------------------------------
// The two tools of the fallback

export const searchToolsInputSchema = z.object({
  connector: z
    .exactOptional(z.string())
    .describe("A connector name from the list: only its tools."),
  words: z
    .exactOptional(z.string())
    .describe('Words about what you need (for example: "search orders customer").'),
  limit: z
    .exactOptional(z.number().int().min(1).max(MAX_SEARCH_RESULTS))
    .describe(`How many definitions to return (default ${DEFAULT_SEARCH_RESULTS}).`),
});

export const useToolInputSchema = z.object({
  tool: z.string().describe("The exact name of the tool, as listed or returned by search_tools."),
  arguments: z
    .exactOptional(z.record(z.string(), z.json()))
    .describe("The arguments, an object that follows the tool's definition."),
});

export const SEARCH_TOOLS_DESCRIPTION_META = `Find tools of the external connectors listed in the system prompt and get their FULL definitions (name, description, input schema as JSON). Give \`connector\` (a connector name from the list) and/or \`words\` about what you need. At most ${MAX_SEARCH_RESULTS} definitions are returned (default ${DEFAULT_SEARCH_RESULTS}); if more tools matched, their names are listed so you can narrow the search. Searching only reads the list: it runs nothing. Then call \`${USE_TOOL_NAME}\`.`;

export const SEARCH_TOOLS_DESCRIPTION_CLIENT = `Load tools of the external connectors listed in the system prompt. Give \`connector\` (a connector name from the list) and/or \`words\` about what you need. The matching tools are loaded and you can call them directly afterwards. Searching only reads the list: it runs nothing.`;

export const USE_TOOL_DESCRIPTION = `Call a connector tool by its exact name, with an \`arguments\` object that follows its definition (get the definition first with \`${SEARCH_TOOL_NAME}\`). The call goes through the same checks as any other tool: the arguments are validated against the real definition (a mistake comes back with the schema so you can fix it), the user's approval applies to the REAL tool, and its result is returned as data from outside.`;

function jsonSchema(schema: z.ZodType): JsonObject {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonObject;
  const { $schema: _ignored, ...rest } = out;
  return rest;
}

/** The specs of the tools the loop handles itself when the run has deferred connector tools. */
export function toolSearchControlSpecs(mode: ToolSearchMode | undefined): ToolSpec[] {
  if (mode === "meta") {
    return [
      {
        name: SEARCH_TOOL_NAME,
        description: SEARCH_TOOLS_DESCRIPTION_META,
        inputSchema: jsonSchema(searchToolsInputSchema),
      },
      {
        name: USE_TOOL_NAME,
        description: USE_TOOL_DESCRIPTION,
        inputSchema: jsonSchema(useToolInputSchema),
      },
    ];
  }
  if (mode === "client") {
    return [
      {
        name: SEARCH_TOOL_NAME,
        description: SEARCH_TOOLS_DESCRIPTION_CLIENT,
        inputSchema: jsonSchema(searchToolsInputSchema),
      },
    ];
  }
  return [];
}

/** The text of an answer to `search_tools` in `meta` mode: the full definitions of the matches. */
export function renderDefinitions(outcome: SearchOutcome, query: SearchQuery): string {
  if (outcome.matches.length === 0) {
    return `No tool matched${query.connector === undefined ? "" : ` in connector "${query.connector}"`}${query.words === undefined ? "" : ` for "${query.words}"`}. Try other words, or a connector name from the list.`;
  }
  const blocks = outcome.matches.map(
    (d) =>
      `### ${d.name}\n${d.spec.description}\nInput schema (JSON):\n${JSON.stringify(d.spec.inputSchema)}`,
  );
  const lines = [
    `${outcome.matches.length} tool(s). Call one with ${USE_TOOL_NAME}: {"tool": "<name>", "arguments": {...}}.`,
    "",
    ...blocks,
  ];
  if (outcome.more.length > 0) {
    lines.push(
      "",
      `${outcome.more.length} more matched; narrow the search to see them: ${outcome.more
        .slice(0, 40)
        .map((d) => d.name)
        .join(", ")}${outcome.more.length > 40 ? ", ..." : ""}`,
    );
  }
  return lines.join("\n");
}

/** The text of an answer to `search_tools` in `client` mode: the names; the API loads the definitions. */
export function renderLoaded(outcome: SearchOutcome, query: SearchQuery): string {
  if (outcome.matches.length === 0) {
    return `No tool matched${query.connector === undefined ? "" : ` in connector "${query.connector}"`}${query.words === undefined ? "" : ` for "${query.words}"`}. Try other words, or a connector name from the list.`;
  }
  const lines = [
    `Loaded ${outcome.matches.length} tool(s): ${outcome.matches.map((d) => d.name).join(", ")}.`,
  ];
  if (outcome.more.length > 0) {
    lines.push(
      `${outcome.more.length} more matched and were not loaded: ${outcome.more
        .slice(0, 40)
        .map((d) => d.name)
        .join(", ")}. Narrow the search to load them.`,
    );
  }
  return lines.join("\n");
}
