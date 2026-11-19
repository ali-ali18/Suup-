// Owns filter 2 of section 4.8, the automatic reviewer: the interface a reviewer implements and
// the deterministic default that only maps the level. No model is called here; a reviewer that
// asks one is a later addition behind the same interface.
import type { JsonValue } from "../messages.js";
import type { RiskLevel } from "../risk.js";

/** `safe` runs, `sensitive` waits for the user, `blocked` is refused. */
export const REVIEW_VERDICTS = ["safe", "sensitive", "blocked"] as const;
export type ReviewVerdictName = (typeof REVIEW_VERDICTS)[number];

export interface ReviewVerdict {
  verdict: ReviewVerdictName;
  reason?: string | undefined;
}

export interface ReviewCall {
  botId: string;
  tool: string;
  args: JsonValue;
  level: RiskLevel;
  summary: string;
}

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
