import type { Discrepancy, PlanStep, UncheckedItem } from "../events.js";
import type { Block, JsonValue } from "../messages.js";
import type { Provider } from "../provider.js";
import { validDiscrepancies, validUnchecked, verdictParseSchema } from "./control-tools.js";
import { formatPlan } from "./prompts.js";
import { ARGS_SNIPPET, type ToolLogEntry, type UserExchange } from "./state.js";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  /** Price of tokens written to the prompt cache; defaults to `inputPerMTok`. */
  cacheWriteInputPerMTok?: number;
}

/** A second opinion on `finish`, from a separate call with a fresh context. */
export interface ReviewerConfig {
  provider: Provider;
  model: {
    id: string;
    maxOutputTokens: number;
    pricing?: ModelPricing;
    /**
     * Whether the model accepts a forced `tool_choice`. Default true. Some models answer a forced
     * choice with an HTTP 400; for those the reviewer asks for the verdict by instruction only
     * (`auto`), which `parseVerdict` already tolerates.
     */
    supportsForcedToolChoice?: boolean;
  };
  /**
   * How many times the reviewer may reject before a human is asked to break the tie.
   * Default 2.
   */
  maxRejections?: number;
}

export const DEFAULT_MAX_REJECTIONS = 2;
export const DIGEST_MAX_CHARS = 20000;

/**
 * A compact account of what the assistant actually did: each tool call with its outcome and the
 * start and end of its result. When it exceeds `maxChars`, the oldest calls are left out.
 */
export function buildReviewDigest(
  log: readonly ToolLogEntry[],
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  if (log.length === 0) return "(the assistant made no tool calls)";
  const entries = log.map((e, i) => {
    const status = e.isError ? `${e.outcome}, error` : e.outcome;
    const lines = [`#${i + 1} ${e.name} ${e.args} -> ${status} (${e.length} chars)`];
    if (e.argsLength > ARGS_SNIPPET) {
      lines.push(
        `  [ARGUMENTS SHORTENED: only the first ${ARGS_SNIPPET} of ${e.argsLength} chars of the call's arguments are shown; ask for "#${i + 1}" in "calls" with need_evidence to see them all (this is different from the result below)]`,
      );
    }
    if (e.tail === "") {
      if (e.head !== "") lines.push(`  result: ${JSON.stringify(e.head)}`);
    } else {
      lines.push(`  start: ${JSON.stringify(e.head)}`);
      lines.push(`  end: ${JSON.stringify(e.tail)}`);
      lines.push(
        `  [SHORTENED: only the start and end of ${e.length} chars are shown; ask for "#${i + 1}" in "results" with need_evidence to see all of it]`,
      );
    }
    return lines.join("\n");
  });
  const kept: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as string;
    if (total + entry.length > maxChars && kept.length > 0) break;
    kept.unshift(entry);
    total += entry.length + 1;
  }
  const omitted = entries.length - kept.length;
  const header =
    omitted > 0
      ? [
          `(${omitted} earlier tool call(s) omitted: #1 to #${omitted}; they can still be requested with need_evidence)`,
        ]
      : [];
  return [...header, ...kept].join("\n");
}

/** The questions the assistant asked the user and what the user said, for the reviewer. */
export function buildUserExchangeDigest(log: readonly UserExchange[]): string {
  if (log.length === 0)
    return "(the assistant did not ask the user anything and the user sent no messages)";
  const label = {
    question: "The assistant asked the user",
    answer: "The user answered",
    message: "The user wrote",
  } as const;
  return log.map((e) => `- ${label[e.kind]}: ${JSON.stringify(e.text)}`).join("\n");
}

export function buildReviewMessage(input: {
  objective: string;
  acceptanceCriteria: readonly string[];
  plan: readonly PlanStep[];
  summary: string;
  evidence: readonly { criterion: string; evidence: string }[];
  digest: string;
  userExchanges?: readonly UserExchange[];
}): string {
  const criteria =
    input.acceptanceCriteria.length === 0
      ? "(none were given)"
      : input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const evidence =
    input.evidence.length === 0
      ? "(none)"
      : input.evidence.map((e) => `- ${e.criterion}: ${e.evidence}`).join("\n");
  return [
    `## Objective\n${input.objective}`,
    `## Acceptance criteria\n${criteria}`,
    `## Final plan\n${input.plan.length === 0 ? "(no plan)" : formatPlan(input.plan)}`,
    `## The assistant's summary\n${input.summary}`,
    `## The assistant's evidence\n${evidence}`,
    `## Exchanges with the user (these are real: the harness records them itself)\n${buildUserExchangeDigest(input.userExchanges ?? [])}`,
    `## What the assistant actually did (tool calls, outcome, start and end of each result)\n${input.digest}`,
    'Decide now and answer with the `verdict` tool. If you cannot verify something because the digest shows it only in part, ask for it with "need_evidence" (digest ids like "#3" in "results" for what a tool returned or in "calls" for the full arguments of a call, and/or workspace file paths in "files") instead of rejecting. A "reject" must list at least one REAL mismatch in "discrepancies" (real_mismatch true; what matched goes in "notes"). A "cannot_verify" must list in "unchecked" what you could not check and what you would need.',
  ].join("\n\n");
}

export interface ParsedVerdict {
  verdict: "approve" | "reject" | "need_evidence" | "cannot_verify";
  notes: string;
  /** The `verdict` call that carried the answer (the evidence or the new question replies to it). */
  callId?: string;
  /** The arguments as sent, kept to rebuild the conversation when the reviewer is asked again. */
  rawArgs?: JsonValue;
  /** `need_evidence`: digest entries (results, calls) and workspace paths the reviewer asked for. */
  results: string[];
  calls: string[];
  files: string[];
  /** `reject`: the real mismatches (all three parts written, marked `real_mismatch` by the reviewer). */
  discrepancies: Discrepancy[];
  /** `cannot_verify`: what the reviewer said it could not check (only entries that name something). */
  unchecked: UncheckedItem[];
  /** Set when a `reject` named no usable discrepancy: it is not a rejection. */
  invalidReject?: string;
  /** Set when the answer was unusable and the verdict is an approval by default. */
  warning?: string;
}

const NO_DISCREPANCY =
  "a reject must list at least one concrete discrepancy in `discrepancies` that is a real mismatch (what the work claims, what the evidence shows instead, where, with `real_mismatch` true)";

/** Why a reject is not accepted; says what became of the entries it did list. */
function noDiscrepancy(listed: number): string {
  if (listed === 0) return NO_DISCREPANCY;
  return `${NO_DISCREPANCY}. The ${listed} entr${listed === 1 ? "y" : "ies"} you listed ${listed === 1 ? "was" : "were"} discarded: marked \`real_mismatch\` false, left it out, or incomplete. What you checked and found correct goes in \`notes\`, not in \`discrepancies\``;
}

function byDefault(warning: string): ParsedVerdict {
  return {
    verdict: "approve",
    notes: "",
    results: [],
    calls: [],
    files: [],
    discrepancies: [],
    unchecked: [],
    warning,
  };
}

/** Reads the reviewer's answer. Anything unusable counts as an approval with a warning. */
export function parseVerdict(blocks: readonly Block[]): ParsedVerdict {
  const call = blocks.find((b) => b.type === "tool_call" && b.name === "verdict");
  if (call === undefined || call.type !== "tool_call") {
    return byDefault("the reviewer did not answer through the verdict tool; approved by default");
  }
  const parsed = verdictParseSchema.safeParse(call.args);
  if (!parsed.success)
    return byDefault("the reviewer's verdict was malformed; approved by default");
  const notes = parsed.data.notes.trim();
  const { verdict } = parsed.data;
  const discrepancies = validDiscrepancies(parsed.data.discrepancies);
  return {
    verdict,
    notes: notes === "" && verdict !== "approve" ? "(no reason given)" : notes,
    callId: call.id,
    rawArgs: call.args,
    results: parsed.data.results ?? [],
    calls: parsed.data.calls ?? [],
    files: parsed.data.files ?? [],
    discrepancies,
    unchecked: validUnchecked(parsed.data.unchecked),
    ...(verdict === "reject" && discrepancies.length === 0
      ? { invalidReject: noDiscrepancy(parsed.data.discrepancies?.length ?? 0) }
      : {}),
  };
}
