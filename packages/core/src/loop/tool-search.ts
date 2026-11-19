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
  /** The connector as written in the tool names (`conn_<connector>`), as the model reads it. */
  prefix?: string;
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

/**
 * Characters per token of the estimate of a tool DEFINITION (name, description and JSON schema),
 * a simple estimate on purpose (no tokenizer). Calibrated on the real run of 19/11/2026
 * (docs/TESTES-REAIS.md, "Fase 3", item D): the 62 connector definitions made the first request
 * 10.1k tokens longer by the provider's own `usage` (21 564 against 11 456), and the estimate at 4
 * characters per token said 6.7k, so a definition is about 1.5 times denser than 4 characters per
 * token: 4 / 1.5 = 2.65. JSON punctuation (braces, quotes, keys) is what makes it so dense. It is
 * still an estimate: `model_response.measure` records the real input tokens beside it.
 */
export const DEFINITION_CHARS_PER_TOKEN = 2.65;

/** Characters per token of the rest of a request (system prompt and messages: prose). */
const PROSE_CHARS_PER_TOKEN = 4;

export function estimateSpecTokens(spec: ToolSpec): number {
  const chars =
    spec.name.length + spec.description.length + (JSON.stringify(spec.inputSchema)?.length ?? 0);
  return Math.ceil(chars / DEFINITION_CHARS_PER_TOKEN);
}

/**
 * A rough estimate of the whole input of one request: the definitions (as above) plus the system
 * prompt and the messages as prose. Only to put beside the provider's real count, never to decide.
 */
export function estimateRequestTokens(spec: {
  system: string;
  messages: readonly unknown[];
  tools: readonly ToolSpec[];
}): number {
  const prose = spec.system.length + (JSON.stringify(spec.messages)?.length ?? 0);
  return (
    Math.ceil(prose / PROSE_CHARS_PER_TOKEN) +
    spec.tools.reduce((sum, t) => sum + estimateSpecTokens(t), 0)
  );
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
    ...(e.prefix === undefined ? {} : { prefix: e.prefix }),
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

interface ConnectorInfo {
  group: string;
  /** The connector as written in the tool names (`conn_<connector>`), when the runtime declared it. */
  prefix: string | undefined;
  count: number;
}

function connectorsOf(deferred: ToolCatalog["deferred"]): ConnectorInfo[] {
  const out: ConnectorInfo[] = [];
  for (const d of deferred) {
    const last = out.find((o) => o.group === d.group);
    if (last === undefined) out.push({ group: d.group, prefix: d.prefix, count: 1 });
    else last.count += 1;
  }
  return out;
}

/** A connector as the model should write it in `connector`: its name, and its form in the tool names. */
function connectorLabel(c: Pick<ConnectorInfo, "group" | "prefix">): string {
  return c.prefix === undefined || c.prefix === c.group
    ? c.group
    : `${c.group} (the \`${c.prefix}\` of the tool names)`;
}

/** The sentence that says how to write `connector`, with a real example when there is one. */
function connectorHint(connectors: readonly ConnectorInfo[]): string {
  const example = connectors.find((c) => c.prefix !== undefined);
  return example?.prefix === undefined
    ? "`connector` is the connector name."
    : `\`connector\` is the connector name or its form in the tool names (for example \`${example.group}\` or \`${example.prefix}\`).`;
}

/** The section of the system prompt that says what can be searched. Fixed for the whole run. */
export function buildIndex(
  mode: ToolSearchMode,
  deferred: ToolCatalog["deferred"],
  maxChars: number,
): string {
  const connectors = connectorsOf(deferred);
  const perConnector = connectors.map((c) => `- ${connectorLabel(c)}: ${c.count} tool(s)`);
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
      `Tools of external connectors are not loaded. Call \`${SEARCH_TOOL_NAME}\` (by connector and/or words) to load the ones you need; after it answers you can call them like any other tool. ${connectorHint(connectors)} Connectors available:`,
      "",
      ...perConnector,
    ].join("\n");
  }
  const first = deferred[0];
  const introOf = (example: string | undefined) => [
    "## Connector tools",
    "",
    `You may use tools of external connectors, but their definitions are not loaded. To use one: call \`${SEARCH_TOOL_NAME}\` (by connector and/or words) to get the full definitions, then call \`${USE_TOOL_NAME}\` with \`tool\` (the name exactly as listed${example === undefined ? "" : `, for example \`${example}\``}) and \`arguments\` (an object that follows the definition). ${connectorHint(connectors)} The harness checks the arguments against the real definition and asks the user for approval exactly as it would for a direct call. Only the tools listed here exist for you.`,
    "",
  ];
  const lines = deferred.map((d) => {
    const hint = firstSentence(d.summary);
    return hint === "" ? `- ${d.name}` : `- ${d.name}: ${hint}`;
  });
  const full = [...introOf(first?.name), "Tools:", ...lines].join("\n");
  if (full.length <= maxChars) return full;
  return [
    ...introOf(undefined),
    `The list is long, so it is grouped by connector. Call \`${SEARCH_TOOL_NAME}\` with \`connector\` to list the tools of one; the names it returns are the ones \`${USE_TOOL_NAME}\` accepts:`,
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
  /**
   * Only the tools of this connector. Compared exactly, lowercased, with what the model reads: the
   * connector's name (`led`) or its form in the tool names (`conn_led`, also with the `__`).
   */
  connector?: string | undefined;
  /** Free words; a tool matches by the words it has in common with these. */
  words?: string | undefined;
  /** How many full definitions to return (1 to `MAX_SEARCH_RESULTS`). */
  limit?: number | undefined;
}

export const DEFAULT_SEARCH_RESULTS = 5;
export const MAX_SEARCH_RESULTS = 10;
/** The names of a set of tools are listed only while they fit this many characters. */
export const MAX_LISTED_NAMES_CHARS = 1_500;

export interface SearchOutcome {
  /** The best matches, at most `limit`. */
  matches: ToolCatalog["deferred"];
  /** More tools matched than `limit`. */
  more: ToolCatalog["deferred"];
  /** A connector was asked for and none of the catalog answers to that name. */
  unknownConnector?: boolean;
  /** The connectors of the catalog, as the model may write them (for the empty answer). */
  connectors: { group: string; prefix?: string }[];
  /**
   * A word query where more tools than `limit` matched equally well (the same number of the words
   * asked): the first ones are shown in catalog order, which says nothing about which is best.
   */
  tied?: { count: number; words: number; asked: number; names: string[] };
}

/** Whether `wanted` (lowercased, trimmed) names the connector of the tool. */
function isConnectorOf(d: ToolCatalog["deferred"][number], wanted: string): boolean {
  const prefix = d.prefix?.toLowerCase();
  return (
    d.group.toLowerCase() === wanted ||
    prefix === wanted ||
    (prefix !== undefined && `${prefix}__` === wanted) ||
    // Older catalogs have no declared prefix: the tool's own name starts with it.
    d.name.toLowerCase().startsWith(`${wanted}__`)
  );
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
  const filtered = connector !== undefined && connector !== "";
  const pool = filtered ? deferred.filter((d) => isConnectorOf(d, connector)) : deferred;
  const connectors = connectorsOf(deferred).map((c) => ({
    group: c.group,
    ...(c.prefix === undefined ? {} : { prefix: c.prefix }),
  }));
  const wanted = [...new Set(wordsOf(query.words ?? ""))];
  let ranked: ToolCatalog["deferred"];
  let tied: SearchOutcome["tied"];
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
    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order);
    ranked = hits.map((s) => s.d);
    const best = hits[0]?.score ?? 0;
    const equal = hits.filter((s) => s.score === best);
    if (equal.length > limit) {
      tied = {
        count: equal.length,
        words: best,
        asked: wanted.length,
        names: equal.map((s) => s.d.name),
      };
    }
  }
  return {
    matches: ranked.slice(0, limit),
    more: ranked.slice(limit),
    connectors,
    ...(filtered && pool.length === 0 ? { unknownConnector: true } : {}),
    ...(tied === undefined ? {} : { tied }),
  };
}

// ---------------------------------------------------------------------------------------------
// The two tools of the fallback

export const searchToolsInputSchema = z.object({
  connector: z
    .exactOptional(z.string())
    .describe(
      "Only the tools of this connector: its name, or its form in the tool names (for example `led` or `conn_led`).",
    ),
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

/** The connectors of the catalog, as the model may write `connector`. */
function validConnectors(outcome: SearchOutcome): string {
  return outcome.connectors
    .map((c) =>
      c.prefix === undefined || c.prefix === c.group ? c.group : `${c.group} or ${c.prefix}`,
    )
    .join("; ");
}

/** What to say when nothing matched: which part of the query found nothing, and what is valid. */
function renderNothing(outcome: SearchOutcome, query: SearchQuery): string {
  if (outcome.unknownConnector === true) {
    return `No connector answers to "${query.connector}". Valid values for \`connector\`: ${validConnectors(outcome)}.`;
  }
  return `No tool matched${query.connector === undefined ? "" : ` in connector "${query.connector}"`}${query.words === undefined ? "" : ` for "${query.words}"`}. Try other words (the words of a tool's name, description or argument names), or \`connector\` (${validConnectors(outcome)}).`;
}

/** The names, joined, only while they fit the bound; otherwise empty. */
function namesThatFit(names: readonly string[]): string {
  const joined = names.join(", ");
  return joined.length <= MAX_LISTED_NAMES_CHARS ? joined : "";
}

/** The note after the results when more tools matched than were returned (or tied for the first place). */
function renderRemainder(outcome: SearchOutcome, shown: string): string[] {
  const { tied } = outcome;
  if (tied !== undefined) {
    const names = namesThatFit(tied.names);
    return [
      "",
      `${tied.count} tools matched equally well (each has ${tied.words} of the ${tied.asked} word(s) asked), so ${shown} the first ${outcome.matches.length} in catalog order, which does not mean they are the best. Refine: use words only the right tool has (its action, its argument names), or give \`connector\`.${names === "" ? "" : ` Tied: ${names}`}`,
    ];
  }
  if (outcome.more.length > 0) {
    const names = namesThatFit(outcome.more.map((d) => d.name));
    return [
      "",
      `${outcome.more.length} more matched; narrow the search to see them.${names === "" ? "" : ` They are: ${names}`}`,
    ];
  }
  return [];
}

/** The text of an answer to `search_tools` in `meta` mode: the full definitions of the matches. */
export function renderDefinitions(outcome: SearchOutcome, query: SearchQuery): string {
  if (outcome.matches.length === 0) return renderNothing(outcome, query);
  const blocks = outcome.matches.map(
    (d) =>
      `### ${d.name}\n${d.spec.description}\nInput schema (JSON):\n${JSON.stringify(d.spec.inputSchema)}`,
  );
  return [
    `${outcome.matches.length} tool(s). Call one with ${USE_TOOL_NAME}: {"tool": "<name>", "arguments": {...}}.`,
    "",
    ...blocks,
    ...renderRemainder(outcome, "these are"),
  ].join("\n");
}

/** The text of an answer to `search_tools` in `client` mode: the names; the API loads the definitions. */
export function renderLoaded(outcome: SearchOutcome, query: SearchQuery): string {
  if (outcome.matches.length === 0) return renderNothing(outcome, query);
  return [
    `Loaded ${outcome.matches.length} tool(s): ${outcome.matches.map((d) => d.name).join(", ")}.`,
    ...renderRemainder(outcome, "only"),
  ].join("\n");
}
