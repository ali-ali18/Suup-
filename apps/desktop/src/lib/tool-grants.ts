import type { ConnectorGrant, ConnectorTool, ToolSelection } from "@suup/api";

// What a bot may use of a connector, as the screen edits it: a tick per tool, plus the shortcuts
// "Selecionar todas", "Só as de leitura" and "Nenhuma". All of it is pure. The server decides what
// is allowed; this only builds the list the person chose and says it back ("3 de 14").
//
// A tool whose definition is `new` or `changed` is off for every bot until a person reviews it, so
// it cannot be ticked here (the server would not offer it either): it shows unticked, with why.

/** What the ticks say: every tool the connector offers (`all`), or exactly these (names on the server). */
export interface GrantDraft {
  all: boolean;
  tools: readonly string[];
}

/** Why a tool cannot be ticked: its definition changed, or it is new, and no one reviewed it yet. */
export type BlockedReason = "changed" | "new";

export interface GrantableTool {
  tool: ConnectorTool;
  blocked: BlockedReason | null;
}

export const NOTHING: GrantDraft = { all: false, tools: [] };

/** The tools a bot can be given: the ones the connector offers, with whether a review blocks them. */
export function grantableTools(tools: readonly ConnectorTool[] | null): GrantableTool[] {
  return (tools ?? [])
    .filter((t) => t.available)
    .map((tool) => ({
      tool,
      blocked: tool.pin === "changed" ? "changed" : tool.pin === "new" ? "new" : null,
    }));
}

/** What the server holds for the bot: nothing at all when it has no grant. */
export function draftOf(grant: ConnectorGrant | undefined): GrantDraft {
  return grant === undefined ? NOTHING : { all: grant.all, tools: [...grant.tools] };
}

/** Whether the box of this tool shows ticked. A blocked tool never does. */
export function isTicked(draft: GrantDraft, item: GrantableTool): boolean {
  if (item.blocked !== null) return false;
  return draft.all || draft.tools.includes(item.tool.tool);
}

/** The names of the tools ticked now, in the order of the connector's list. */
export function tickedNames(draft: GrantDraft, list: readonly GrantableTool[]): string[] {
  return list.filter((item) => isTicked(draft, item)).map((item) => item.tool.tool);
}

/** Flips one tool. Unticking one of "all" turns the rest into an explicit list. */
export function toggleTool(
  draft: GrantDraft,
  list: readonly GrantableTool[],
  name: string,
): GrantDraft {
  const item = list.find((i) => i.tool.tool === name);
  if (item === undefined || item.blocked !== null) return draft;
  const ticked = tickedNames(draft, list);
  return {
    all: false,
    tools: ticked.includes(name) ? ticked.filter((n) => n !== name) : [...ticked, name],
  };
}

/** "Selecionar todas": the one way to get `all` (it also covers tools the connector gains later). */
export const selectAll = (): GrantDraft => ({ all: true, tools: [] });

/** "Nenhuma". */
export const selectNone = (): GrantDraft => NOTHING;

/** "Só as de leitura": the tools whose risk is `read`, sent as a list (never as `all`). */
export function selectReadOnly(list: readonly GrantableTool[]): GrantDraft {
  return {
    all: false,
    tools: list
      .filter((item) => item.blocked === null && item.tool.risk === "read")
      .map((item) => item.tool.tool),
  };
}

/** The two numbers of "3 de 14": what is ticked, and what the connector offers. */
export function countOf(
  draft: GrantDraft,
  list: readonly GrantableTool[],
): { selected: number; total: number } {
  return { selected: tickedNames(draft, list).length, total: list.length };
}

/** The count as the collapsed row says it. */
export function countLabel(draft: GrantDraft, list: readonly GrantableTool[]): string {
  const { selected, total } = countOf(draft, list);
  return draft.all ? `${selected} de ${total} (todas)` : `${selected} de ${total}`;
}

/** Whether the person changed anything from what the server holds. */
export function isDirty(draft: GrantDraft, saved: GrantDraft): boolean {
  if (draft.all !== saved.all) return true;
  if (draft.all) return false;
  const a = [...draft.tools].sort();
  const b = [...saved.tools].sort();
  return a.length !== b.length || a.some((name, i) => name !== b[i]);
}

/** The body of the write: `all` only when the person picked "todas", else exactly what is ticked. */
export function grantBody(
  draft: GrantDraft,
  list: readonly GrantableTool[],
): { tools: ToolSelection } {
  return { tools: draft.all ? "all" : tickedNames(draft, list) };
}

/** How many tools of the list are blocked by a review (to say it under the list). */
export function blockedCount(list: readonly GrantableTool[]): number {
  return list.filter((item) => item.blocked !== null).length;
}

/** The reason line shown on a tool that cannot be ticked. */
export const BLOCKED_TEXT: Record<BlockedReason, string> = {
  changed: "A definição mudou: desligada até você revisar.",
  new: "Ferramenta nova: desligada até você revisar.",
};
