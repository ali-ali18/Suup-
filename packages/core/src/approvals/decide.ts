// Owns the decision itself: the three filters of section 4.8, in order, as one pure function.
// Everything it needs (the rules, the reviewer's verdict) is handed in, so the same inputs always
// give the same answer and the answer can be tested without a database or a model.
import type { PolicySource } from "../events.js";
import type { RiskLevel } from "../risk.js";
import { levelVerdict, type ReviewVerdict, stricter } from "./reviewer.js";
import { type ApprovalRule, type RuleCall, ruleMatches } from "./rules.js";

export type PolicyOutcome = "allow" | "deny" | "ask";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Which filter decided. */
  source: PolicySource;
  ruleId?: string;
  /** For a denial: why, in words the model and the user can read. */
  reason?: string;
}

export interface DecideInput {
  call: RuleCall;
  level: RiskLevel;
  rules: readonly ApprovalRule[];
  /** The reviewer's verdict (filter 2). Omitted: only the level counts. */
  review?: ReviewVerdict | undefined;
}

function ruleLabel(rule: ApprovalRule): string {
  return rule.note !== undefined && rule.note !== "" ? `"${rule.note}"` : rule.id;
}

/**
 * 1. Rules of the user: a matching `deny` wins over everything (even over an `allow`), then a
 *    matching `allow`. Among rules of the same effect the order given decides, and a rule of the
 *    bot comes before a global one.
 * 2. The reviewer, combined with the level's default (the stricter wins).
 * 3. What is left to ask is `ask`: the approval card.
 */
export function decidePolicy(input: DecideInput): PolicyDecision {
  const { call, level, rules } = input;
  const matching = rules
    .filter((rule) => ruleMatches(rule, call))
    .sort((a, b) => Number(b.botId !== null) - Number(a.botId !== null));
  const deny = matching.find((rule) => rule.effect === "deny");
  if (deny !== undefined) {
    return {
      outcome: "deny",
      source: "rule",
      ruleId: deny.id,
      reason: `a rule of the user forbids this (${ruleLabel(deny)})`,
    };
  }
  const allow = matching.find((rule) => rule.effect === "allow");
  if (allow !== undefined) return { outcome: "allow", source: "rule", ruleId: allow.id };

  const base = levelVerdict(level);
  const review = input.review === undefined ? base : stricter(base, input.review);
  const source: PolicySource = review === base ? "default" : "reviewer";
  switch (review.verdict) {
    case "safe":
      return { outcome: "allow", source };
    case "sensitive":
      return { outcome: "ask", source };
    case "blocked":
      return {
        outcome: "deny",
        source,
        reason: review.reason ?? "the automatic review blocked this call",
      };
  }
}
