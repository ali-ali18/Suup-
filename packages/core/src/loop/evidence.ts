// Owns the evidence rounds of the independent review: what the reviewer may ask for when the digest
// shows a result only in part (whole tool results and workspace files), how much of it the harness
// shows (one fixed budget, with an explicit mark of what was cut), and how the answer is written
// down so that resume and replay rebuild exactly the same conversation.
import type { RunEventPayload } from "../events.js";
import { scrub } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { ToolLogEntry } from "./state.js";

/** How many times the reviewer may ask for evidence in one review. Then it must decide. */
export const EVIDENCE_MAX_ROUNDS = 2;
/** The most characters of evidence shown in one round, over all items. */
export const EVIDENCE_BUDGET_CHARS = 60_000;
/** The most items (tool results and files together) honored in one round. */
export const EVIDENCE_MAX_ITEMS = 6;
/** Larger files are not read at all: the reviewer is told, instead of being shown a fragment. */
export const EVIDENCE_MAX_FILE_BYTES = 200_000;

export type EvidencePayload = RunEventPayload<"review_evidence">;

export interface EvidenceAsk {
  callId: string;
  notes: string;
  results: readonly string[];
  files: readonly string[];
}

/** A short fingerprint of a text (not cryptographic), enough to tell contents apart in the log. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Splits `budget` over items of the given lengths: small items are shown whole and the rest is
 * shared equally among the large ones. Deterministic, and never above an item's own length.
 */
export function allocateBudget(lengths: readonly number[], budget: number): number[] {
  const order = lengths
    .map((_, i) => i)
    .sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0) || a - b);
  const out: number[] = lengths.map(() => 0);
  let remaining = budget;
  order.forEach((index, position) => {
    const left = order.length - position;
    const share = Math.floor(remaining / left);
    const take = Math.min(lengths[index] ?? 0, share);
    out[index] = take;
    remaining -= take;
  });
  return out;
}

/** The part of a text that is shown: its start and its end, with the cut marked in between. */
export function showWithinBudget(content: string, sent: number): string {
  if (sent >= content.length) return content;
  const head = Math.ceil(sent * 0.7);
  const tail = sent - head;
  const cut = content.length - sent;
  return `${content.slice(0, head)}\n[... ${cut} characters cut here to fit the evidence budget ...]\n${tail === 0 ? "" : content.slice(content.length - tail)}`;
}

/** Looks up a digest entry named as "#3", "3" or by call id; `undefined` when there is none. */
function findEntry(
  log: readonly ToolLogEntry[],
  ref: string,
): { entry: ToolLogEntry; index: number } | undefined {
  const text = ref.trim();
  const numeric = /^#?(\d+)$/.exec(text);
  if (numeric !== null) {
    const index = Number(numeric[1]);
    const entry = log[index - 1];
    if (entry !== undefined) return { entry, index };
  }
  const at = log.findIndex((e) => e.callId === text);
  const entry = log[at];
  return entry === undefined ? undefined : { entry, index: at + 1 };
}

interface Candidate {
  item: EvidencePayload["supplied"][number];
  length: number;
}

/**
 * Collects what the reviewer asked for. Tool results come from the event log, files from the
 * run's executor (read only: `stat` and `readFile`, nothing else). An item that cannot be supplied
 * is reported with the reason; it never fails the review.
 */
export async function gatherEvidence(
  ctx: LoopContext,
  ask: EvidenceAsk,
  round: number,
): Promise<EvidencePayload> {
  const log = ctx.state.toolLog;
  const missing: EvidencePayload["missing"] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let results: Map<string, string> | undefined;

  const names = [
    ...ask.results.map((ref) => ({ kind: "result" as const, ref })),
    ...ask.files.map((ref) => ({ kind: "file" as const, ref })),
  ];
  for (const { kind, ref } of names) {
    const key = `${kind}:${kind === "file" ? ref.trim() : ref.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidates.length >= EVIDENCE_MAX_ITEMS) {
      missing.push({
        item: ref,
        reason: `not supplied: at most ${EVIDENCE_MAX_ITEMS} items per round`,
      });
      continue;
    }
    if (kind === "result") {
      const found = findEntry(log, ref);
      if (found === undefined) {
        missing.push({
          item: ref,
          reason: `no such tool result (the digest lists #1 to #${log.length})`,
        });
        continue;
      }
      if (
        candidates.some((c) => c.item.kind === "tool_result" && c.item.ref === found.entry.callId)
      ) {
        continue;
      }
      results ??= await toolResultContents(ctx);
      const content = results.get(found.entry.callId);
      if (content === undefined) {
        missing.push({ item: ref, reason: "the result is not in the log" });
        continue;
      }
      candidates.push({
        item: {
          kind: "tool_result",
          ref: found.entry.callId,
          index: found.index,
          chars: content.length,
          sent: content.length,
        },
        length: content.length,
      });
      continue;
    }
    const read = await readWorkspaceFile(ctx, ref.trim());
    if ("reason" in read) {
      missing.push({ item: ref, reason: scrub(ctx, read.reason) });
      continue;
    }
    // A file can hold a value the vault knows (a token in a config file): it is scrubbed HERE,
    // before the lengths, the fingerprint and the budget are computed, so what is recorded and
    // what the reviewer sees are the same text and the numbers describe it.
    const content = scrub(ctx, read.content);
    candidates.push({
      item: {
        kind: "file",
        ref: ref.trim(),
        chars: content.length,
        sent: content.length,
        hash: fingerprint(content),
        content,
      },
      length: content.length,
    });
  }

  const shares = allocateBudget(
    candidates.map((c) => c.length),
    EVIDENCE_BUDGET_CHARS,
  );
  const supplied = candidates.map((c, i) => ({ ...c.item, sent: shares[i] ?? 0 }));
  return {
    round,
    callId: ask.callId,
    notes: ask.notes,
    requested: { results: [...ask.results], files: [...ask.files] },
    supplied,
    missing,
    budgetChars: EVIDENCE_BUDGET_CHARS,
  };
}

/** Full content of every recorded tool result, by call id. */
export async function toolResultContents(ctx: LoopContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const event of await ctx.deps.store.listEvents(ctx.runId)) {
    if (event.type === "tool_result" && !out.has(event.payload.callId)) {
      out.set(event.payload.callId, event.payload.content);
    }
  }
  return out;
}

async function readWorkspaceFile(
  ctx: LoopContext,
  path: string,
): Promise<{ content: string } | { reason: string }> {
  if (path === "") return { reason: "empty path" };
  try {
    const stat = await ctx.deps.executor.stat(path);
    if (stat === null) return { reason: "no such file in the workspace" };
    if (stat.kind !== "file") return { reason: "it is a directory, not a file" };
    if (stat.size > EVIDENCE_MAX_FILE_BYTES) {
      return {
        reason: `file too large to supply (${stat.size} bytes, limit ${EVIDENCE_MAX_FILE_BYTES})`,
      };
    }
    return { content: await ctx.deps.executor.readFile(path) };
  } catch (error) {
    return {
      reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The text the reviewer gets back as the result of its `need_evidence` call. */
export function renderEvidence(
  payload: EvidencePayload,
  log: readonly ToolLogEntry[],
  results: ReadonlyMap<string, string>,
): string {
  const blocks: string[] = [];
  let cut = 0;
  for (const item of payload.supplied) {
    cut += item.chars - item.sent;
    const size =
      item.sent >= item.chars
        ? `${item.chars} chars, shown in full`
        : `${item.chars} chars, CUT: showing ${item.sent}, ${item.chars - item.sent} left out`;
    if (item.kind === "tool_result") {
      const entry = log[item.index - 1];
      const label = entry === undefined ? "" : ` ${entry.name} ${entry.args}`;
      const content = results.get(item.ref) ?? "(not in the log)";
      blocks.push(
        `### Tool result #${item.index}${label} (${size})\n${showWithinBudget(content, item.sent)}`,
      );
    } else {
      blocks.push(`### File ${item.ref} (${size})\n${showWithinBudget(item.content, item.sent)}`);
    }
  }
  if (payload.missing.length > 0) {
    blocks.push(
      `### Not supplied\n${payload.missing.map((m) => `- ${JSON.stringify(m.item)}: ${m.reason}`).join("\n")}`,
    );
  }
  if (payload.supplied.length === 0 && payload.missing.length === 0) {
    blocks.push("### Not supplied\n- you named no items");
  }
  const budget =
    cut > 0
      ? `Budget: ${payload.budgetChars} characters of evidence per round; ${cut} characters were cut (marked above). Anything inside a cut is NOT verified.`
      : `Budget: ${payload.budgetChars} characters of evidence per round; nothing was cut.`;
  const left = EVIDENCE_MAX_ROUNDS - payload.round;
  const next =
    left > 0
      ? `You may ask for evidence ${left} more time(s). Otherwise decide now.`
      : 'That was the last evidence round. Decide now with the `verdict` tool: "approve", "reject" (only for a concrete discrepancy) or "cannot_verify" (say exactly what you could not verify).';
  return [
    `Evidence round ${payload.round} of ${EVIDENCE_MAX_ROUNDS}.`,
    ...blocks,
    budget,
    next,
  ].join("\n\n");
}
