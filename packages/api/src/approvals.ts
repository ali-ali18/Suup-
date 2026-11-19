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
 * The tool's declaration that a call is a MESSAGE TO ANOTHER PERSON (an e-mail and the like). It is
 * never guessed from a name or a text: a tool declares it, or, for a connector tool, the user marks
 * the tool in the connector's settings. Only an approval that carries it gets the message card.
 */
export const outboundMessageSchema = z.strictObject({
  kind: z.literal("message"),
  /** Where the recipients are in the call's arguments (dotted paths: `to`, `cc`). */
  recipientFields: z.array(z.string().min(1).max(200)).min(1).max(8),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

/** An outbound message as the card sees it: the declaration plus what "allow this recipient" would pin. */
export const approvalOutboundSchema = outboundMessageSchema.extend({
  /**
   * Exactly what "Permitir destinatário" would write into the rule (each recipient field equal to
   * this call's value), or `null` when that cannot be said exactly (several recipients in a list,
   * a missing field): the card then does not offer it.
   */
  recipients: z.array(z.strictObject({ field: z.string(), value: z.string() })).nullable(),
});
export type ApprovalOutbound = z.infer<typeof approvalOutboundSchema>;

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
  /** Set only when the call is a message to another person; the card is the message card then. */
  outbound: approvalOutboundSchema.nullable(),
  status: approvalStatusSchema,
  /** The reason given with a denial. */
  reason: z.string().nullable(),
  /** The rule "Permitir destinatário" created, when it did. */
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

/**
 * One condition of a rule: the named argument must be EXACTLY this value. There is no operator
 * (no prefix, substring, pattern): a request that sends one (`op`) is refused, not read as equality.
 */
export const argMatcherSchema = z.strictObject({
  /** A dotted path into the arguments (`command`, `options.branch`). */
  field: z.string().min(1).max(200),
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
  /** Exact equality of named arguments, all must hold (AND). Empty means ANY use of the tool. */
  matchers: z.array(argMatcherSchema),
  /** `false`: the rule does not apply (migration 0013 disabled the rules that used a pattern). */
  enabled: z.boolean(),
  /** Why it is disabled, in words for the person. */
  disabledReason: z.string().nullable(),
  note: z.string().nullable(),
  /** `approval`: created by "Permitir destinatário" on a message card. */
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
  /** `true` turns a disabled rule on (its conditions must all be exact); `false` turns it off. */
  enabled: z.boolean().optional(),
});
export type UpdateRuleBody = z.input<typeof updateRuleBodySchema>;

// ---- decision ----------------------------------------------------------------------------

export const decideApprovalBodySchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approve"),
    /**
     * Only for a message to another person: also create an allow rule for exactly this recipient,
     * for this bot ("Permitir destinatário"). Refused for any other call.
     */
    allowRecipient: z.boolean().optional(),
  }),
  z.strictObject({ decision: z.literal("deny"), reason: z.string().max(2000).optional() }),
]);
export type DecideApprovalBody = z.input<typeof decideApprovalBodySchema>;

export const decideApprovalResultSchema = z.object({
  approval: approvalSchema,
  /** The rule "Permitir destinatário" created, when it did. */
  rule: ruleSchema.nullable(),
});
export type DecideApprovalResult = z.infer<typeof decideApprovalResultSchema>;
