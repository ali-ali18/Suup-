// Owns the evidence rounds of the independent review: what the reviewer may ask for when the digest
// shows something only in part (whole tool results, the full arguments of tool calls, workspace
// files), how much of it the harness shows (one character budget, filled in the order asked, with
// an explicit mark of what was cut or left out), and how the answer is written down so that resume
// and replay rebuild exactly the same conversation. How it is shown is in `evidence-render.ts`.

import type { RunEventPayload } from "../events.js";
import type { JsonValue } from "../messages.js";
import type { LoopContext } from "./run-context.js";
import type { ToolLogEntry } from "./state.js";

/**
 * How many times the reviewer may ask for evidence in one review. Then it must decide. Three, not
 * two: with a character budget (and not an item count) as the limit, a round may leave out what
 * did not fit, and the reviewer is told exactly which items; the second round is where it asks
 * for them, and the third is slack for one follow-up question that reading them raises. Each round
 * costs one more reviewer call with at most `EVIDENCE_BUDGET_CHARS` more context, and counts in the
 * run's turn and cost limits, so the total stays bounded.
 */
export const EVIDENCE_MAX_ROUNDS = 3;
/** The most characters of evidence shown in one round, over all items: the real limit. */
export const EVIDENCE_BUDGET_CHARS = 60_000;
/** A sanity cap on the items named in one round (not the working limit: the budget is). */
export const EVIDENCE_MAX_ITEMS = 24;
/** An item that does not fit whole is cut only if at least this much of the budget is left. */
export const EVIDENCE_MIN_PARTIAL_CHARS = 4_000;
/** Larger files are not read at all: the reviewer is told, instead of being shown a fragment. */
export const EVIDENCE_MAX_FILE_BYTES = 200_000;

export type EvidencePayload = RunEventPayload<"review_evidence">;

export interface EvidenceAsk {
  callId: string;
  notes: string;
  /** Tool results, tool calls (their arguments) and workspace files, each in the order asked. */
  results: readonly string[];
  calls: readonly string[];
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
 * Fills `budget` in the order the items were asked for. An item that fits in what is left is shown
 * whole; the first one that does not fit is cut to what remains, if that is worth showing
 * (`EVIDENCE_MIN_PARTIAL_CHARS`); every other is left out (0), to be asked for again. Whole items
 * come first so that a later small one is not lost to the fragment of an earlier large one.
 * Deterministic. Returns how many characters of each item to show.
 */
export function fillBudget(lengths: readonly number[], budget: number): number[] {
  const out = lengths.map(() => 0);
  let remaining = budget;
  const unfit: number[] = [];
  lengths.forEach((length, i) => {
    if (length <= remaining) {
      out[i] = length;
      remaining -= length;
    } else {
      unfit.push(i);
    }
  });
  const first = unfit[0];
  if (first !== undefined && remaining >= EVIDENCE_MIN_PARTIAL_CHARS) out[first] = remaining;
  return out;
}

/**
 * The arguments of a call as text a reviewer can read: keys in sorted order (so the text never
 * depends on how the store orders them), a string value as it is (a script keeps its real lines,
 * not `\n` escapes) and any other value as JSON.
 */
export function renderCallArgs(args: JsonValue): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return JSON.stringify(args) ?? "null";
  }
  return Object.keys(args)
    .sort()
    .map((key) => {
      const value = args[key] as JsonValue;
      if (typeof value !== "string") return `${key}: ${JSON.stringify(value)}`;
      return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
    })
    .join("\n");
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

/** What the log holds in full, by call id: the content of each result and the arguments of each call. */
export interface Logged {
  results: Map<string, string>;
  args: Map<string, JsonValue>;
}

export async function loadLogged(ctx: LoopContext): Promise<Logged> {
  const out: Logged = { results: new Map(), args: new Map() };
  for (const event of await ctx.deps.store.listEvents(ctx.runId)) {
    if (event.type === "tool_result" && !out.results.has(event.payload.callId)) {
      out.results.set(event.payload.callId, event.payload.content);
    } else if (event.type === "tool_call" && !out.args.has(event.payload.callId)) {
      out.args.set(event.payload.callId, event.payload.args as JsonValue);
    }
  }
  return out;
}

interface Candidate {
  item: EvidencePayload["supplied"][number];
  /** What the reviewer typed, to name the item if it is left out. */
  asked: string;
}

/**
 * Collects what the reviewer asked for, in the order asked (results, then calls, then files). Tool
 * results and call arguments come from the event log, files from the run's executor (read only:
 * `stat` and `readFile`, nothing else; it never leaves the workspace). An item that cannot be
 * supplied is reported with the reason; one that only did not fit the budget is reported as left
 * out so the reviewer can ask for it again. Nothing here fails the review.
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
  let logged: Logged | undefined;

  const names = [
    ...ask.results.map((ref) => ({ kind: "tool_result" as const, ref })),
    ...ask.calls.map((ref) => ({ kind: "tool_call" as const, ref })),
    ...ask.files.map((ref) => ({ kind: "file" as const, ref })),
  ];
  let named = 0;
  for (const { kind, ref } of names) {
    const key = `${kind}:${ref.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (++named > EVIDENCE_MAX_ITEMS) {
      missing.push({
        item: ref,
        reason: `not considered: at most ${EVIDENCE_MAX_ITEMS} items can be named in one round`,
      });
      continue;
    }
    if (kind === "file") {
      const read = await readWorkspaceFile(ctx, ref.trim());
      if ("reason" in read) {
        logged ??= await loadLogged(ctx);
        missing.push({ item: ref, reason: read.reason, hint: fileHint(log, logged, ref.trim()) });
        continue;
      }
      candidates.push({
        asked: ref,
        item: {
          kind: "file",
          ref: ref.trim(),
          chars: read.content.length,
          sent: read.content.length,
          hash: fingerprint(read.content),
          content: read.content,
        },
      });
      continue;
    }
    const noun = kind === "tool_result" ? "result" : "call";
    const found = findEntry(log, ref);
    if (found === undefined) {
      missing.push({
        item: ref,
        reason: `no such tool ${noun} (the digest lists #1 to #${log.length})`,
      });
      continue;
    }
    if (candidates.some((c) => c.item.kind === kind && c.item.ref === found.entry.callId)) continue;
    logged ??= await loadLogged(ctx);
    const content =
      kind === "tool_result"
        ? logged.results.get(found.entry.callId)
        : logged.args.has(found.entry.callId)
          ? renderCallArgs(logged.args.get(found.entry.callId) as JsonValue)
          : undefined;
    if (content === undefined) {
      missing.push({ item: ref, reason: `the ${noun} is not in the log` });
      continue;
    }
    candidates.push({
      asked: ref,
      item: {
        kind,
        ref: found.entry.callId,
        index: found.index,
        chars: content.length,
        sent: content.length,
      },
    });
  }

  const shares = fillBudget(
    candidates.map((c) => c.item.chars),
    EVIDENCE_BUDGET_CHARS,
  );
  const supplied: EvidencePayload["supplied"] = [];
  const omitted: { item: string; chars: number }[] = [];
  candidates.forEach((c, i) => {
    const sent = shares[i] ?? 0;
    if (sent === 0 && c.item.chars > 0) omitted.push({ item: c.asked, chars: c.item.chars });
    else supplied.push({ ...c.item, sent });
  });
  return {
    round,
    callId: ask.callId,
    notes: ask.notes,
    requested: { results: [...ask.results], calls: [...ask.calls], files: [...ask.files] },
    supplied,
    missing,
    ...(omitted.length === 0 ? {} : { omitted }),
    budgetChars: EVIDENCE_BUDGET_CHARS,
  };
}

/**
 * Why a file could not be had and what to try: the executor never leaves the workspace (that
 * boundary is not relaxed), but the content may have been written by a tool call, in which case it
 * is the arguments of that call. Names the calls that mention the path when there are any.
 */
function fileHint(log: readonly ToolLogEntry[], logged: Logged, path: string): string {
  const mentions: string[] = [];
  log.forEach((entry, i) => {
    const args = logged.args.get(entry.callId);
    if (args !== undefined && JSON.stringify(args).includes(path)) mentions.push(`#${i + 1}`);
  });
  const where =
    mentions.length > 0
      ? `call ${mentions.join(", ")} mention${mentions.length === 1 ? "s" : ""} this path`
      : "the call that wrote it is listed in the digest";
  return `Only files inside the workspace can be read. If this content was written by a tool call (for example a script created inside a shell command), it may be available as the arguments of that call: ${where}; ask for it in "calls" (like "#3").`;
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
