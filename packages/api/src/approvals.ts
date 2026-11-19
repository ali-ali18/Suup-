import { z } from "zod";
import { intQuery, isoDate, uuid } from "./common.js";

export const RISK_LEVELS = ["read", "write_reversible", "external_irreversible"] as const;
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "cancelled", "expired"] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Which of the three filters sent the call to the card: a rule, the automatic reviewer, or the level's default. */
export const POLICY_SOURCES = ["rule", "reviewer", "default"] as const;

/**
 * An approval card: a tool call that waits for the user, with the exact content that will run.
 * `args` is what the tool will receive if approved; a secret appears as its placeholder
 * (`{{secret:NAME}}`), never as a value.
 */
export const approvalSchema = z.object({
  id: uuid,
  runId: uuid,
  botId: uuid,
  /** The conversation of the run, when it has one. */
  conversationId: uuid.nullable(),
  /** The model's id of the call inside the run. */
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
  level: riskLevelSchema,
  /** One line saying what the call does: the title of the card. */
  summary: z.string(),
  /** The secrets the call uses (names). */
  secrets: z.array(z.string()),
  source: z.enum(POLICY_SOURCES),
  status: approvalStatusSchema,
  /** The reason given with a denial. */
  reason: z.string().nullable(),
  /** The rule an "approve and always allow" created. */
  ruleId: uuid.nullable(),
  /** Only when the configuration makes requests expire. */
  expiresAt: isoDate.nullable(),
  decidedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type Approval = z.infer<typeof approvalSchema>;

export const listApprovalsQuerySchema = z.object({
  status: approvalStatusSchema.optional(),
  botId: uuid.optional(),
  conversationId: uuid.optional(),
  runId: uuid.optional(),
  limit: intQuery(1, 200).default(50),
});
export interface ListApprovalsQuery {
  status?: ApprovalStatus;
  botId?: string;
  conversationId?: string;
  runId?: string;
  limit?: number;
}
export const approvalListSchema = z.object({ items: z.array(approvalSchema) });

// ---- rules -------------------------------------------------------------------------------

export const MATCH_OPS = ["equals", "starts_with", "contains", "glob"] as const;
export const argMatcherSchema = z.object({
  /** A dotted path into the arguments (`command`, `options.branch`). */
  field: z.string().min(1).max(200),
  op: z.enum(MATCH_OPS),
  value: z.string().max(2000),
});
export type ArgMatcher = z.infer<typeof argMatcherSchema>;

export const ruleSchema = z.object({
  id: uuid,
  /** `null`: every bot. */
  botId: uuid.nullable(),
  /** A tool name, or `*` for any tool. */
  tool: z.string(),
  effect: z.enum(["allow", "deny"]),
  /** All must hold (AND); empty means any call of the tool. */
  matchers: z.array(argMatcherSchema),
  note: z.string().nullable(),
  /** `approval`: created by an "approve and always allow". */
  createdBy: z.enum(["user", "approval"]),
  sourceApprovalId: uuid.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type ApprovalRule = z.infer<typeof ruleSchema>;

export const ruleListSchema = z.object({ items: z.array(ruleSchema) });

export const listRulesQuerySchema = z.object({
  /** Only the rules that apply to this bot: its own and the global ones. */
  botId: uuid.optional(),
});
export interface ListRulesQuery {
  botId?: string;
}

export const createRuleBodySchema = z.object({
  botId: uuid.nullable().optional(),
  tool: z.string().min(1).max(64),
  effect: z.enum(["allow", "deny"]),
  matchers: z.array(argMatcherSchema).max(20).optional(),
  note: z.string().max(500).optional(),
});
export type CreateRuleBody = z.input<typeof createRuleBodySchema>;

export const updateRuleBodySchema = z.object({
  effect: z.enum(["allow", "deny"]).optional(),
  matchers: z.array(argMatcherSchema).max(20).optional(),
  note: z.string().max(500).nullable().optional(),
});
export type UpdateRuleBody = z.input<typeof updateRuleBodySchema>;

// ---- decision ----------------------------------------------------------------------------

/** What "approve and always allow" turns into: a rule for this bot or for all, exact or any-arguments. */
export const alwaysAllowSchema = z.object({
  scope: z.enum(["bot", "global"]).default("bot"),
  /** Omitted: exactly this call (every text argument equal). `[]`: any call of the tool. */
  matchers: z.array(argMatcherSchema).max(20).optional(),
});

export const decideApprovalBodySchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), always: alwaysAllowSchema.optional() }),
  z.object({ decision: z.literal("deny"), reason: z.string().max(2000).optional() }),
]);
export type DecideApprovalBody = z.input<typeof decideApprovalBodySchema>;

export const decideApprovalResultSchema = z.object({
  approval: approvalSchema,
  /** The rule that "always allow" created. */
  rule: ruleSchema.nullable(),
});
export type DecideApprovalResult = z.infer<typeof decideApprovalResultSchema>;
