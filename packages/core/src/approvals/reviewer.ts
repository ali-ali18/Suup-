// Owns filter 2 of section 4.8, the automatic reviewer: the interface a reviewer implements and
// the deterministic default that only maps the level. No model is called here; a reviewer that
// asks one is a later addition behind the same interface.
import type { ReviewDecision, ReviewScope } from "../events.js";
import type { JsonValue } from "../messages.js";
import type { OutboundMessage } from "../outbound.js";
import type { Usage } from "../provider.js";
import type { RiskLevel } from "../risk.js";
import type { JudgedKind } from "../tool.js";
import type { WrittenRule } from "./written-rules.js";

/** `safe` runs, `sensitive` waits for the user, `blocked` is refused. */
export const REVIEW_VERDICTS = ["safe", "sensitive", "blocked"] as const;
export type ReviewVerdictName = (typeof REVIEW_VERDICTS)[number];

/** What a reviewer that asks a model reports besides its verdict (kept in `approval_review`). */
export interface ModelAnswer {
  /** What the model said. `ask` when it said nothing valid (then `failure` says why). */
  decision: ReviewDecision;
  /** The written rule it named, as it named it (the gate checks that it exists and what kind it is). */
  ruleId: string | null;
  /** One short sentence for the user. */
  reason: string;
  /** Judged calls only: where the call reaches, as the model said (checked by `resolveReview`). */
  scope?: ReviewScope | undefined;
  /** Judged calls only: whether the model said the call can be undone. */
  reversible?: boolean | undefined;
  model: string;
  promptVersion: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  /** The call failed, timed out or answered something invalid. */
  failure?: "error" | "invalid_output" | undefined;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictName;
  reason?: string | undefined;
  /** Only a reviewer that asks a model sets it. */
  model?: ModelAnswer | undefined;
}

/**
 * A run that the user did not start by typing: today, a routine's fire (docs/ROTINAS.md). The
 * instruction was stored earlier, with the user's approval; the fire itself is not the user
 * speaking now and approves nothing.
 */
export interface ReviewTrigger {
  kind: "routine";
  /** The routine's instruction (the run's objective). */
  instruction: string;
}

/** What only the reviewer that asks a model is given (the level reviewer never is). */
export interface ModelReviewContext {
  /** What the tool declares it does. */
  toolDescription: string;
  /** Set when the tool declares the call as a message to another person. */
  outbound?: OutboundMessage | undefined;
  /** The user's own messages in this conversation, oldest first, already bounded. */
  userMessages: readonly string[];
  /** Set when a routine, not the user typing now, started the run. */
  trigger?: ReviewTrigger | undefined;
  /** Set when the harness lets the model settle this irreversible call (see `Tool.judged`). */
  judged?: JudgedKind | undefined;
  /** The enabled written rules of this bot (its own and the ones for every bot). */
  rules: readonly WrittenRule[];
  signal?: AbortSignal | undefined;
}

export interface ReviewCall {
  botId: string;
  tool: string;
  args: JsonValue;
  level: RiskLevel;
  summary: string;
  /** Present only for the reviewer that asks a model. Never a tool result, never assistant text. */
  context?: ModelReviewContext | undefined;
}

/**
 * CONTRACT for every reviewer, today the table and tomorrow one that asks a model (docs/APROVACOES.md,
 * "Revisor automático"; research: docs/pesquisas/fase-3-aprovacoes-cofre-conectores.md):
 *
 * 1. It receives the user's request and the PROPOSED call (`ReviewCall`) and NOTHING ELSE. In
 *    particular never a tool RESULT: results are where an injection arrives, and a reviewer that reads
 *    them can be talked into approving. (Claude Code's auto mode removes results from its classifier
 *    for the same reason.) `ReviewCall` has no field for one, and must not get one.
 * 2. It is SYNCHRONOUS and BLOCKING: `review` is awaited before anything runs. A reviewer that works
 *    in parallel with the action (a guardrail that may fire after the tool already ran) is not allowed.
 * 3. An error, a timeout or a missing or unknown verdict means ASK THE USER, never allow. The gate
 *    turns a thrown error or an invalid verdict into `sensitive`.
 * 4. It can only tighten: `stricter(level, review)`. A "safe" never waves through an irreversible
 *    action; only a rule the user created does.
 */
export interface AutoReviewer {
  review(call: ReviewCall): Promise<ReviewVerdict>;
}

/** What the level alone says (section 4.8's table). */
export function levelVerdict(level: RiskLevel): ReviewVerdict {
  return { verdict: level === "external_irreversible" ? "sensitive" : "safe" };
}

/** The default reviewer: no judgment, just the table. */
export const levelReviewer: AutoReviewer = {
  async review(call) {
    return levelVerdict(call.level);
  },
};

const ORDER: Record<ReviewVerdictName, number> = { safe: 0, sensitive: 1, blocked: 2 };

/**
 * The more restrictive of two verdicts. A reviewer can only tighten what the level says: it can
 * never wave through an irreversible action, which only a rule of the user may allow.
 */
export function stricter(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
  return ORDER[b.verdict] > ORDER[a.verdict] ? b : a;
}
