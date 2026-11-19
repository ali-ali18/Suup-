// Owns the user's standing rules about tool calls (filter 1 of section 4.8): what a rule looks
// like, and whether it matches a call. Pure: no storage, no clock.
import { z } from "zod";
import type { JsonValue } from "../messages.js";

/** How a matcher compares the argument: the whole text, its start, a part of it, or a `*`/`?` pattern. */
export const MATCH_OPS = ["equals", "starts_with", "contains", "glob"] as const;
export type MatchOp = (typeof MATCH_OPS)[number];

/** One condition on one argument. A rule with several matchers needs all of them (AND). */
export const argMatcherSchema = z.object({
  /** A dotted path into the arguments, e.g. `command` or `options.branch`. */
  field: z.string().min(1).max(200),
  op: z.enum(MATCH_OPS),
  value: z.string().max(2000),
});
export type ArgMatcher = z.infer<typeof argMatcherSchema>;

export const RULE_EFFECTS = ["allow", "deny"] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** A standing rule. `botId: null` is global; `tool: "*"` is every tool. */
export interface ApprovalRule {
  id: string;
  botId: string | null;
  tool: string;
  effect: RuleEffect;
  matchers: ArgMatcher[];
  note?: string | undefined;
}

/** What a rule is matched against. The arguments are the model's, placeholders included. */
export interface RuleCall {
  botId: string;
  tool: string;
  args: JsonValue;
}

function valueAt(args: unknown, field: string): unknown {
  let node: unknown = args;
  for (const part of field.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** A glob (`*` any run of characters, `?` one character) as an anchored expression. */
function globToRegExp(pattern: string): RegExp {
  const source = [...pattern]
    .map((ch) =>
      ch === "*"
        ? "[\\s\\S]*"
        : ch === "?"
          ? "[\\s\\S]"
          : ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

export function matcherMatches(matcher: ArgMatcher, args: unknown): boolean {
  const found = valueAt(args, matcher.field);
  if (typeof found !== "string" && typeof found !== "number" && typeof found !== "boolean") {
    return false;
  }
  const text = String(found);
  switch (matcher.op) {
    case "equals":
      return text === matcher.value;
    case "starts_with":
      return text.startsWith(matcher.value);
    case "contains":
      return text.includes(matcher.value);
    case "glob":
      return globToRegExp(matcher.value).test(text);
  }
}

/** Whether the rule covers this call: same bot (or a global rule), same tool (or `*`), every matcher. */
export function ruleMatches(rule: ApprovalRule, call: RuleCall): boolean {
  if (rule.botId !== null && rule.botId !== call.botId) return false;
  if (rule.tool !== "*" && rule.tool !== call.tool) return false;
  return rule.matchers.every((m) => matcherMatches(m, call.args));
}

/**
 * The matchers of an "approve and always allow" that means exactly this call: every top-level
 * text argument must be equal. (Numbers such as a timeout are left free: they do not say what the
 * call does.)
 */
export function exactMatchers(args: JsonValue): ArgMatcher[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([field, value]) => ({ field, op: "equals" as const, value }));
}
