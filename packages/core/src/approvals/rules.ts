// Owns the user's standing rules about tool calls (filter 1 of section 4.8): what a rule looks
// like, and whether it matches a call. Pure: no storage, no clock.
import { z } from "zod";
import type { JsonValue } from "../messages.js";

/**
 * One condition on one argument: the argument must be EXACTLY this value. There is no other way
 * to compare (no prefix, no substring, no pattern, no regular expression): what runs without
 * asking is only ever what the user wrote out in full. A rule with several matchers needs all of
 * them (AND).
 */
export const argMatcherSchema = z.strictObject({
  /** A dotted path into the arguments, e.g. `command` or `options.branch`. */
  field: z.string().min(1).max(200),
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

export function matcherMatches(matcher: ArgMatcher, args: unknown): boolean {
  const found = valueAt(args, matcher.field);
  if (typeof found !== "string" && typeof found !== "number" && typeof found !== "boolean") {
    return false;
  }
  return String(found) === matcher.value;
}

/** Whether the rule covers this call: same bot (or a global rule), same tool (or `*`), every matcher. */
export function ruleMatches(rule: ApprovalRule, call: RuleCall): boolean {
  if (rule.botId !== null && rule.botId !== call.botId) return false;
  if (rule.tool !== "*" && rule.tool !== call.tool) return false;
  return rule.matchers.every((m) => matcherMatches(m, call.args));
}

/**
 * The matchers of "allow this recipient": each recipient field of an outbound message must be
 * exactly what it is in this call. `null` when that cannot be said exactly: no field declared, a
 * field that is missing, empty, or not a single piece of text (a list of recipients, say).
 */
export function recipientMatchers(
  args: JsonValue,
  outbound: { recipientFields: readonly string[] },
): ArgMatcher[] | null {
  if (outbound.recipientFields.length === 0) return null;
  const matchers: ArgMatcher[] = [];
  for (const field of outbound.recipientFields) {
    const found = valueAt(args, field);
    if (typeof found !== "string" || found.trim() === "" || found.length > 2000) return null;
    matchers.push({ field, value: found });
  }
  return matchers;
}
