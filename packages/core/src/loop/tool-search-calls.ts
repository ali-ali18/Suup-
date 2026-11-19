// Owns the two tools of the tool search that the loop handles itself: `search_tools` (finds
// deferred connector tools) and `use_tool` (calls one of them by name, `meta` mode). `use_tool`
// never runs anything on its own: it only RESOLVES the call to the real tool, and the real call
// goes through the same gate, approval card, vault substitution, registry and untrusted labelling
// as a direct one (see `handleTool`). Only the tools of the run's catalog can be resolved: a tool
// that was not granted is not in it, so it cannot be reached by name, by search or by reference.
import { wrapUntrusted } from "../untrusted.js";
import { renderArgIssues } from "./control-tools.js";
import { type ControlCall, ensureToolCall, recordResult } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import {
  renderDefinitions,
  renderLoaded,
  SEARCH_TOOL_NAME,
  searchCatalog,
  searchToolsInputSchema,
  USE_TOOL_NAME,
  useToolInputSchema,
} from "./tool-search.js";

export async function handleSearchTools(ctx: LoopContext, call: ControlCall): Promise<void> {
  await ensureToolCall(ctx, call);
  const catalog = ctx.state.toolCatalog;
  if (catalog === null || (catalog.mode !== "meta" && catalog.mode !== "client")) {
    await recordResult(ctx, call.id, {
      outcome: "unknown_tool",
      isError: true,
      content: `Unknown tool "${SEARCH_TOOL_NAME}": this run has no searchable connector tools.`,
    });
    return;
  }
  const parsed = searchToolsInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues(SEARCH_TOOL_NAME, parsed.error),
    });
    return;
  }
  const query = parsed.data;
  if (
    (query.connector === undefined || query.connector.trim() === "") &&
    (query.words === undefined || query.words.trim() === "")
  ) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: `Give \`connector\` and/or \`words\`. Connectors: ${[...new Set(catalog.deferred.map((d) => (d.prefix === undefined ? d.group : `${d.group} or ${d.prefix}`)))].join("; ")}.`,
    });
    return;
  }
  const outcome = searchCatalog(catalog.deferred, query);
  if (catalog.mode === "client") {
    // The names go back as `tool_reference`s: the provider loads those definitions.
    await recordResult(ctx, call.id, {
      outcome: "ok",
      isError: false,
      content: renderLoaded(outcome, query),
      ...(outcome.matches.length === 0
        ? {}
        : { toolReferences: outcome.matches.map((m) => m.name) }),
    });
    return;
  }
  // The definitions carry text written by the connector's server: it goes back as data.
  await recordResult(ctx, call.id, {
    outcome: "ok",
    isError: false,
    content:
      outcome.matches.length === 0
        ? renderDefinitions(outcome, query)
        : wrapUntrusted(SEARCH_TOOL_NAME, renderDefinitions(outcome, query)),
  });
}

/** What `use_tool` resolved to: the real call, or the reason there is none (already recorded). */
export type ResolvedUse = { kind: "call"; call: ControlCall; schema: string } | { kind: "refused" };

export async function resolveUseTool(ctx: LoopContext, call: ControlCall): Promise<ResolvedUse> {
  const catalog = ctx.state.toolCatalog;
  const refuse = async (
    outcome: "unknown_tool" | "invalid_args",
    content: string,
  ): Promise<ResolvedUse> => {
    await ensureToolCall(ctx, call);
    await recordResult(ctx, call.id, { outcome, isError: true, content });
    return { kind: "refused" };
  };
  if (catalog === null || catalog.mode !== "meta") {
    return refuse(
      "unknown_tool",
      `Unknown tool "${USE_TOOL_NAME}": this run has no searchable connector tools.`,
    );
  }
  const parsed = useToolInputSchema.safeParse(call.args);
  if (!parsed.success) return refuse("invalid_args", renderArgIssues(USE_TOOL_NAME, parsed.error));
  const entry = catalog.deferred.find((d) => d.name === parsed.data.tool);
  if (entry === undefined) {
    return refuse(
      "unknown_tool",
      `Unknown tool "${parsed.data.tool}". Only the tools listed in the system prompt exist; find the exact name with ${SEARCH_TOOL_NAME}.`,
    );
  }
  return {
    kind: "call",
    call: { id: call.id, name: entry.name, args: parsed.data.arguments ?? {} },
    schema: JSON.stringify(entry.spec.inputSchema),
  };
}
