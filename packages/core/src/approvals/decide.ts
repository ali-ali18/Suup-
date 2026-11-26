// Owns the decision itself: the three filters of section 4.8, in order, as one pure function.
// Everything it needs (the rules, the reviewer's verdict) is handed in, so the same inputs always
// give the same answer and the answer can be tested without a database or a model.
import type { PolicySource } from "../events.js";
import type { RiskLevel } from "../risk.js";
import type { JudgedKind } from "../tool.js";
import { levelVerdict, type ModelAnswer, type ReviewVerdict, stricter } from "./reviewer.js";
import { type ApprovalRule, type RuleCall, ruleMatches } from "./rules.js";
import type { ApprovalMode, WrittenRule } from "./written-rules.js";

export type PolicyOutcome = "allow" | "deny" | "ask";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Which filter decided. */
  source: PolicySource;
  ruleId?: string;
  /** For a denial or a question: why, in words the model and the user can read. */
  reason?: string;
  /** The WRITTEN rule behind the decision (not the id of an exact rule: that one is `ruleId`). */
  writtenRuleId?: string;
}

/** What the model reviewer's answer comes to once the harness has checked it against the rules. */
export interface ReviewResolution {
  outcome: PolicyOutcome;
  writtenRuleId?: string;
  reason: string;
  /** Set when the harness changed what the model said: what it checked. */
  adjusted?: string;
}

export interface DecideInput {
  call: RuleCall;
  level: RiskLevel;
  rules: readonly ApprovalRule[];
  /** The reviewer's verdict (filter 2). Omitted: only the level counts. */
  review?: ReviewVerdict | undefined;
  /** The approval mode (default `auto_review`). */
  mode?: ApprovalMode | undefined;
  /** Set when a hard floor applies (why): the call asks whatever the rules and the mode say. */
  floor?: string | undefined;
  /**
   * The settled answer of the model reviewer (`resolveReview`), when the call went through it.
   * Used only for what the exact rules, the floors and the mode left undecided.
   */
  resolved?: ReviewResolution | undefined;
}

/**
 * Checks the model's answer against the written rules, in code: the model proposes, the harness
 * disposes. A `block` counts only if it names a rule of kind `never`; a `run` never counts if it
 * names a `never` or an `ask` rule (an `ask` rule beats an `allow` rule), and on an irreversible
 * call counts only if it names an `allow` rule. A rule id that does not exist is no rule. Anything
 * the checks refuse becomes `ask`: the user decides.
 */
/** The scope the model has to give for a judged call to run without a card. */
export const SCOPE_FOR_JUDGED: Record<JudgedKind, string> = {
  local_shell: "inside_bot_folder_reversible",
  unseen_web_page: "public_page_no_user_data",
};

export function resolveReview(
  answer: Pick<ModelAnswer, "decision" | "ruleId" | "reason" | "failure" | "scope">,
  level: RiskLevel,
  rules: readonly WrittenRule[],
  judged?: JudgedKind,
): ReviewResolution {
  const rule =
    answer.ruleId === null ? undefined : rules.find((candidate) => candidate.id === answer.ruleId);
  const named = rule === undefined ? {} : { writtenRuleId: rule.id };
  const ask = (adjusted?: string): ReviewResolution => ({
    outcome: "ask",
    ...named,
    reason: answer.reason,
    ...(adjusted === undefined ? {} : { adjusted }),
  });
  if (answer.failure !== undefined) return { outcome: "ask", reason: answer.reason };
  if (answer.ruleId !== null && rule === undefined) return ask("unknown rule id");
  switch (answer.decision) {
    case "ask":
      return ask();
    case "block":
      return rule?.kind === "never"
        ? { outcome: "deny", writtenRuleId: rule.id, reason: `Bloqueado pela regra "${rule.text}"` }
        : ask("block without a rule of kind never");
    case "run":
      if (rule?.kind === "never" || rule?.kind === "ask") {
        return ask(`run names a rule of kind ${rule.kind}`);
      }
      if (level === "external_irreversible" && rule?.kind !== "allow") {
        // A judged call (declared by the tool) may also run on the model's word, but only if the
        // model gave exactly the scope that kind of call needs. No scope, no run.
        if (judged === undefined || answer.scope !== SCOPE_FOR_JUDGED[judged]) {
          return ask(
            judged === undefined
              ? "run on an irreversible call without a rule of kind allow"
              : `run on a judged call (${judged}) without the scope it needs`,
          );
        }
      }
      return { outcome: "allow", ...named, reason: answer.reason };
  }
}

function ruleLabel(rule: ApprovalRule): string {
  return rule.note !== undefined && rule.note !== "" ? `"${rule.note}"` : rule.id;
}

/**
 * 1. Exact rules of the user: a matching `deny` wins over everything (even over an `allow`).
 * 2. Mode `ask_all`: every call that is not a plain read is a card.
 * 3. A matching exact `allow` rule (an exact, explicit choice of the user: it stays honored, as
 *    before). Among rules of the same effect the order given decides, and a rule of the bot comes
 *    before a global one.
 * 4. The hard floors (`floor`): always a card, whatever a WRITTEN rule or the model say.
 * 5. The model reviewer's settled answer (`resolved`), if the call went through it; otherwise the
 *    reviewer of the level table, combined with the level's default (the stricter wins).
 * 6. What is left to ask is `ask`: the approval card.
 */
export function decidedBeforeReview(
  input: Pick<DecideInput, "call" | "level" | "rules" | "mode" | "floor">,
): PolicyDecision | undefined {
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
  if (input.mode === "ask_all" && level !== "read") {
    return { outcome: "ask", source: "default", reason: 'Modo "Perguntar tudo".' };
  }
  const allow = matching.find((rule) => rule.effect === "allow");
  if (allow !== undefined) return { outcome: "allow", source: "rule", ruleId: allow.id };
  if (input.floor !== undefined) return { outcome: "ask", source: "default", reason: input.floor };
  return undefined;
}

export function decidePolicy(input: DecideInput): PolicyDecision {
  const early = decidedBeforeReview(input);
  if (early !== undefined) return early;
  if (input.resolved !== undefined) {
    const { resolved } = input;
    return {
      outcome: resolved.outcome,
      source: "reviewer",
      ...(resolved.writtenRuleId === undefined ? {} : { writtenRuleId: resolved.writtenRuleId }),
      reason: resolved.reason,
    };
  }
  const base = levelVerdict(input.level);
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
