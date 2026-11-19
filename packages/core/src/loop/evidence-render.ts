// How the evidence of a review round is shown to the reviewer (and rebuilt, identically, on resume
// and replay): the text of a call's arguments, the cut of a long item, and the round's message.
import type { JsonValue } from "../messages.js";
import {
  EVIDENCE_MAX_ROUNDS,
  type EvidencePayload,
  type Logged,
  renderCallArgs,
} from "./evidence.js";
import type { ToolLogEntry } from "./state.js";

/** The part of a text that is shown: its start and its end, with the cut marked in between. */
export function showWithinBudget(content: string, sent: number): string {
  if (sent >= content.length) return content;
  const head = Math.ceil(sent * 0.7);
  const tail = sent - head;
  const cut = content.length - sent;
  return `${content.slice(0, head)}\n[... ${cut} characters cut here to fit the evidence budget ...]\n${tail === 0 ? "" : content.slice(content.length - tail)}`;
}

/** The text the reviewer gets back as the result of its `need_evidence` call. */
export function renderEvidence(
  payload: EvidencePayload,
  log: readonly ToolLogEntry[],
  logged: Logged,
): string {
  const blocks: string[] = [];
  let cut = 0;
  for (const item of payload.supplied) {
    cut += item.chars - item.sent;
    const size =
      item.sent >= item.chars
        ? `${item.chars} chars, shown in full`
        : `${item.chars} chars, CUT: showing ${item.sent}, ${item.chars - item.sent} left out`;
    if (item.kind === "file") {
      blocks.push(`### File ${item.ref} (${size})\n${showWithinBudget(item.content, item.sent)}`);
      continue;
    }
    const entry = log[item.index - 1];
    if (item.kind === "tool_result") {
      const label = entry === undefined ? "" : ` ${entry.name} ${entry.args}`;
      const content = logged.results.get(item.ref) ?? "(not in the log)";
      blocks.push(
        `### Tool RESULT of call #${item.index}${label} (${size})\n${showWithinBudget(content, item.sent)}`,
      );
    } else {
      const label = entry === undefined ? "" : ` ${entry.name}`;
      blocks.push(
        `### Tool CALL #${item.index}${label}: its full ARGUMENTS, not its result (${size})\n${showWithinBudget(logged.args.has(item.ref) ? renderCallArgs(logged.args.get(item.ref) as JsonValue) : "(not in the log)", item.sent)}`,
      );
    }
  }
  if (payload.missing.length > 0) {
    blocks.push(
      `### Not supplied\n${payload.missing.map((m) => `- ${JSON.stringify(m.item)}: ${m.reason}${m.hint === undefined ? "" : `. ${m.hint}`}`).join("\n")}`,
    );
  }
  const omitted = payload.omitted ?? [];
  if (omitted.length > 0) {
    blocks.push(
      `### Left out for budget (NOT shown; ask for them again in the next round, they are the first in line then)\n${omitted.map((o) => `- ${JSON.stringify(o.item)} (${o.chars} chars)`).join("\n")}`,
    );
  }
  if (payload.supplied.length === 0 && payload.missing.length === 0 && omitted.length === 0) {
    blocks.push("### Not supplied\n- you named no items");
  }
  const budget =
    cut > 0
      ? `Budget: ${payload.budgetChars} characters of evidence per round, filled in the order you listed (results, then calls, then files); ${cut} characters were cut (marked above). Anything inside a cut is NOT verified.`
      : `Budget: ${payload.budgetChars} characters of evidence per round, filled in the order you listed; nothing was cut.`;
  const left = EVIDENCE_MAX_ROUNDS - payload.round;
  const pending = omitted.length > 0 ? " Ask for the items left out for budget first." : "";
  const next =
    left > 0
      ? `You may ask for evidence ${left} more time(s).${pending} Otherwise decide now.`
      : `That was the last evidence round.${omitted.length > 0 ? " The items left out for budget stay unverified." : ""} Decide now with the \`verdict\` tool: "approve", "reject" (only for a concrete discrepancy, listed in \`discrepancies\`) or "cannot_verify" (say exactly what you could not verify).`;
  return [
    `Evidence round ${payload.round} of ${EVIDENCE_MAX_ROUNDS}.`,
    ...blocks,
    budget,
    next,
  ].join("\n\n");
}
