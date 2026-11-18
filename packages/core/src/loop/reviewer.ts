import type { PlanStep } from "../events.js";
import type { Block } from "../messages.js";
import type { Provider } from "../provider.js";
import { verdictInputSchema } from "./control-tools.js";
import { formatPlan } from "./prompts.js";
import type { ToolLogEntry, UserExchange } from "./state.js";

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
export const DIGEST_MAX_CHARS = 8000;

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
    if (e.tail === "") {
      if (e.head !== "") lines.push(`  result: ${JSON.stringify(e.head)}`);
    } else {
      lines.push(`  start: ${JSON.stringify(e.head)}`);
      lines.push(`  end: ${JSON.stringify(e.tail)}`);
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
  const header = omitted > 0 ? [`(${omitted} earlier tool call(s) omitted)`] : [];
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
    "Decide now and answer with the `verdict` tool.",
  ].join("\n\n");
}

export interface ParsedVerdict {
  verdict: "approve" | "reject";
  notes: string;
  /** Set when the answer was unusable and the verdict is an approval by default. */
  warning?: string;
}

/** Reads the reviewer's answer. Anything unusable counts as an approval with a warning. */
export function parseVerdict(blocks: readonly Block[]): ParsedVerdict {
  const call = blocks.find((b) => b.type === "tool_call" && b.name === "verdict");
  if (call === undefined || call.type !== "tool_call") {
    return {
      verdict: "approve",
      notes: "",
      warning: "the reviewer did not answer through the verdict tool; approved by default",
    };
  }
  const parsed = verdictInputSchema.safeParse(call.args);
  if (!parsed.success) {
    return {
      verdict: "approve",
      notes: "",
      warning: "the reviewer's verdict was malformed; approved by default",
    };
  }
  const notes = parsed.data.notes.trim();
  return {
    verdict: parsed.data.verdict,
    notes: notes === "" && parsed.data.verdict === "reject" ? "(no reason given)" : notes,
  };
}
