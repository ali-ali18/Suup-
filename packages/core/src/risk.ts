import type { ClassifyEnv, Tool } from "./tool.js";

/**
 * How much a call can hurt (plan, section 4.8): `read` only observes, `write_reversible` changes
 * state that can be undone (a file on the bot's own machine), `external_irreversible` has effects
 * outside or cannot be taken back (sends, posts, pays, deletes elsewhere).
 */
export const RISK_LEVELS = ["read", "write_reversible", "external_irreversible"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

/** The more dangerous of two levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

/**
 * The level of one call. A tool that declares nothing (a missing or unknown `risk`), or whose
 * `classify` throws or answers something that is not a level, is `external_irreversible`: the safe
 * side is the one that asks. The arguments given are the validated ones.
 */
export function classifyCall(tool: Tool<unknown>, input: unknown, env: ClassifyEnv): RiskLevel {
  if (tool.classify !== undefined) {
    try {
      const level = tool.classify(input, env);
      return isRiskLevel(level) ? level : "external_irreversible";
    } catch {
      return "external_irreversible";
    }
  }
  return isRiskLevel(tool.risk) ? tool.risk : "external_irreversible";
}
