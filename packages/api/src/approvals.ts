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
  /** The site the secrets would be sent to (read by the server from the call's destination), or `null`. */
  secretHost: z.string().nullable().optional(),
  source: z.enum(POLICY_SOURCES),
  /** Set only when the call is a message to another person; the card is the message card then. */
  outbound: approvalOutboundSchema.nullable(),
  status: approvalStatusSchema,
  /** The reason given with a denial. */
  reason: z.string().nullable(),
  /** The rule "Permitir destinatário" created, when it did. */
  ruleId: uuid.nullable(),
  /**
   * Why the card exists, when the automatic review (or a fixed rule of the harness) sent the call
   * to you: one short sentence in Portuguese. `null` (the server always sends the field) when nothing said why.
   */
  reviewReason: z.string().nullable().optional(),
  /** The written rule that sentence rests on, if it cited one. It may have been deleted since. */
  writtenRuleId: uuid.nullable().optional(),
  /** Only when the configuration makes requests expire. */
  expiresAt: isoDate.nullable(),
  decidedAt: isoDate.nullable(),
  createdAt: isoDate,
  /** How long the card waited until the user decided it, in milliseconds; `null` while it is pending. */
  waitedMs: z.number().int().nonnegative().nullable(),
  /**
   * The card was approved after waiting longer than the staleness limit: the action did NOT run
   * then; the bot was told and the approval is kept as a one-time grant for the identical call.
   */
  stale: z.boolean(),
  /**
   * How the user decided: `click` (the button or the API) or `chat` (a message that was a clear yes
   * to this card; the app draws "Aprovado pelo chat"). `null` while pending or when it ended without the user.
   */
  decidedVia: z.enum(["click", "chat"]).nullable().optional(),
  /** The user's message that approved, when `decidedVia` is `chat`. */
  decidedMessageId: uuid.nullable().optional(),
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

// ---- written rules and the mode ---------------------------------------------------------

export const WRITTEN_RULE_KINDS = ["never", "ask", "allow"] as const;
export const writtenRuleKindSchema = z.enum(WRITTEN_RULE_KINDS);
export type WrittenRuleKind = z.infer<typeof writtenRuleKindSchema>;

/** The text of a written rule: free prose, trimmed, 1 to 500 characters. Nothing parses it. */
export const MAX_WRITTEN_RULE_CHARS = 500;
const writtenRuleText = z
  .string()
  .transform((text) => text.trim())
  .pipe(z.string().min(1).max(MAX_WRITTEN_RULE_CHARS));

/**
 * A rule the user WROTE in plain language ("Permitir sem perguntar: e-mails para minha equipe em
 * acme.com"). A model reads it when it reviews a call. `never`: the call is refused; `ask`: you are
 * asked; `allow`: it may run without asking (an irreversible call needs one of these to run).
 */
export const writtenRuleSchema = z.object({
  id: uuid,
  kind: writtenRuleKindSchema,
  text: z.string(),
  /** `null`: every bot. */
  botId: uuid.nullable(),
  enabled: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type WrittenRule = z.infer<typeof writtenRuleSchema>;
export const writtenRuleListSchema = z.object({ items: z.array(writtenRuleSchema) });

export const listWrittenRulesQuerySchema = z.object({
  /** Only the rules that apply to this bot: its own and the ones for every bot. */
  botId: uuid.optional(),
});
export interface ListWrittenRulesQuery {
  botId?: string;
}

export const createWrittenRuleBodySchema = z.strictObject({
  kind: writtenRuleKindSchema,
  text: writtenRuleText,
  botId: uuid.nullable().optional(),
  enabled: z.boolean().optional(),
});
export type CreateWrittenRuleBody = z.input<typeof createWrittenRuleBodySchema>;

export const updateWrittenRuleBodySchema = z.strictObject({
  kind: writtenRuleKindSchema.optional(),
  text: writtenRuleText.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWrittenRuleBody = z.input<typeof updateWrittenRuleBodySchema>;

export const APPROVAL_MODES = ["auto_review", "ask_all"] as const;
export const approvalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/**
 * The approval mode and whether "Auto-review" can really review. `auto_review` asks a model that
 * reads your written rules; `ask_all` asks you about every call that is not a plain read. When the
 * reviewer is not available, `auto_review` still works as the table of risk levels does (reads and
 * reversible writes run; what goes out or cannot be undone asks) and `reviewer.reason` says why.
 */
export const STALE_AFTER_MINUTES_MIN = 5;
export const STALE_AFTER_MINUTES_MAX = 10080;

export const approvalSettingsSchema = z.object({
  mode: approvalModeSchema,
  /**
   * `approvals.staleAfterMinutes`: approving a card that waited longer than this does not run the
   * action at once (default 60; from 5 minutes to 1 week). Cards still never expire by themselves.
   */
  staleAfterMinutes: z.number().int().min(STALE_AFTER_MINUTES_MIN).max(STALE_AFTER_MINUTES_MAX),
  reviewer: z.object({
    available: z.boolean(),
    /** The model that reviews, as configured; `null` when none is. */
    model: z.string().nullable(),
    /** Why it is not available, in words for the person. `null` when it is. */
    reason: z.string().nullable(),
  }),
});
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;

export const updateApprovalSettingsBodySchema = z
  .strictObject({
    mode: approvalModeSchema.optional(),
    staleAfterMinutes: z
      .number()
      .int()
      .min(STALE_AFTER_MINUTES_MIN)
      .max(STALE_AFTER_MINUTES_MAX)
      .optional(),
  })
  .refine((b) => b.mode !== undefined || b.staleAfterMinutes !== undefined, {
    message: "Informe mode ou staleAfterMinutes.",
  });
export type UpdateApprovalSettingsBody = z.input<typeof updateApprovalSettingsBodySchema>;

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
