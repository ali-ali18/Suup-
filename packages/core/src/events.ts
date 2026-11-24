import { z } from "zod";
import { blockSchema, messageSchema } from "./messages.js";
import { outboundMessageSchema } from "./outbound.js";
import {
  PROVIDER_ERROR_KINDS,
  stopReasonSchema,
  toolChoiceSchema,
  toolSpecSchema,
  usageSchema,
} from "./provider.js";
import { TOOL_OUTCOMES } from "./registry.js";
import { RISK_LEVELS } from "./risk.js";

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  note: z.exactOptional(z.string()),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/** One memory shown to the model: the id lets the user (and `forget`) refer to it. */
/** A choice offered with a question (`escalate`). The answer is still plain text: the label, or free text. */
export const escalateOptionSchema = z.object({
  label: z.string().describe("Short text of the choice (a few words). It becomes the reply."),
  description: z
    .exactOptional(z.string())
    .describe("Optional one-line explanation of what the choice means."),
});
export type EscalateOption = z.infer<typeof escalateOptionSchema>;

/** One question of a questionnaire (`escalate`): free text, or a choice among discrete options. */
export const escalateQuestionSchema = z.object({
  question: z.string(),
  /** 2 to 6 choices, only when the answers are genuinely discrete. */
  options: z.exactOptional(z.array(escalateOptionSchema).min(2).max(6)),
  /** The user may pick several options. */
  multiple: z.exactOptional(z.boolean()),
  /** The user may answer with something that is not in the list. */
  allowOther: z.exactOptional(z.boolean()),
});
export type EscalateQuestion = z.infer<typeof escalateQuestionSchema>;

/**
 * The questionnaire an `escalated` event asks, in ONE shape: the event keeps a plain single
 * question as just `question`, and anything richer as `questions`; this reads both.
 */
export function escalatedQuestions(payload: {
  question: string;
  questions?: readonly EscalateQuestion[] | undefined;
}): EscalateQuestion[] {
  return payload.questions === undefined
    ? [{ question: payload.question }]
    : [...payload.questions];
}

export const riskLevelSchema = z.enum(RISK_LEVELS);

/**
 * What the tool definitions of one model request cost, estimated at one token per four characters
 * (a simple estimate, not a provider count): how many definitions were sent, how many of them stay
 * out of the model's context until it searches (`deferred`), and the tokens of all of them and of
 * the ones that are loaded.
 */
export const toolStatsSchema = z.object({
  definitions: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  loadedTokens: z.number().int().nonnegative(),
});
export type ToolStats = z.infer<typeof toolStatsSchema>;

/** How the connector tools of the run reach the model. */
export const TOOL_SEARCH_MODES = ["direct", "hosted", "client", "meta"] as const;
export type ToolSearchMode = (typeof TOOL_SEARCH_MODES)[number];

/**
 * The decision of how this run offers its connector tools, taken ONCE (see `tool_catalog`):
 * `direct` every definition is sent on every request; `hosted` / `client` the provider's native
 * deferred loading; `meta` the harness's own index plus `search_tools` and `use_tool`.
 */
export const toolCatalogSchema = z.object({
  mode: z.enum(TOOL_SEARCH_MODES),
  /** With `hosted`: the search the provider runs. */
  variant: z.exactOptional(z.enum(["bm25", "regex"])),
  settings: z.object({
    minTools: z.number().int().nonnegative(),
    minDefinitionTokens: z.number().int().nonnegative(),
  }),
  /** The connector tools granted to the bot, and what their definitions would cost (estimated). */
  connectorTools: z.number().int().nonnegative(),
  definitionTokens: z.number().int().nonnegative(),
  /** The tools kept out of the request's context (empty with `direct`), in a fixed order. */
  deferred: z.array(
    z.object({
      name: z.string(),
      /** The connector the tool belongs to. */
      group: z.string(),
      /** The connector as written in the tool names (`conn_<connector>`); absent in older logs. */
      prefix: z.exactOptional(z.string()),
      /** What the server says it does, cleaned and bounded (untrusted text). */
      summary: z.string(),
      /** The definition, exactly as it goes in the request. */
      spec: toolSpecSchema,
    }),
  ),
  /** The section of the system prompt that lists what can be searched; fixed for the run. */
  index: z.exactOptional(z.string()),
});
export type ToolCatalog = z.infer<typeof toolCatalogSchema>;

/** Which of the three filters (section 4.8) decided: a user rule, the automatic reviewer, or the level's default. */
export const POLICY_SOURCES = ["rule", "reviewer", "default"] as const;
export const policySourceSchema = z.enum(POLICY_SOURCES);
export type PolicySource = z.infer<typeof policySourceSchema>;

/** What the model reviewer may say about a call. */
export const REVIEW_DECISIONS = ["run", "ask", "block"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Why the harness settled a review without the model's own answer: `error` the call failed, timed
 * out or answered nothing valid; `cap` too many blocks in the run, the user is asked from now on;
 * `too_large` the arguments do not fit the review.
 */
export const REVIEW_SKIPS = ["error", "cap", "too_large"] as const;

/** One review by the model reviewer, as the log keeps it (docs/APROVACOES.md, "Auto-review"). */
export const approvalReviewSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  level: riskLevelSchema,
  /** What the model answered; `ask` when it answered nothing valid (see `skipped`). */
  decision: z.enum(REVIEW_DECISIONS),
  /** The written rule the model named; `null` when none (or one that does not exist). */
  ruleId: z.string().nullable(),
  /** One short sentence for the user. */
  reason: z.string(),
  /** What the harness did with it, after its own checks: run, ask the user, or refuse. */
  outcome: z.enum(["allow", "ask", "deny"]),
  /** Set when the harness changed the model's answer (what it checked and why). */
  adjusted: z.exactOptional(z.string()),
  /** Set when there was no valid answer from the model. */
  skipped: z.exactOptional(z.enum(REVIEW_SKIPS)),
  model: z.exactOptional(z.string()),
  promptVersion: z.exactOptional(z.string()),
  usage: z.exactOptional(usageSchema),
  costUsd: z.exactOptional(z.number().nonnegative()),
  latencyMs: z.exactOptional(z.number().nonnegative()),
});
export type ApprovalReview = z.infer<typeof approvalReviewSchema>;

/** How an approval ended: the user answered, the run was cancelled, or a configured limit expired it. */
export const APPROVAL_DECISIONS = ["approved", "denied", "cancelled", "expired"] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** A secret the bot may use, as the model is told about it: the name, never the value. */
export const secretInfoSchema = z.object({ name: z.string(), description: z.string() });
export type SecretInfo = z.infer<typeof secretInfoSchema>;

/** One concrete discrepancy named by the reviewer: what the work claims, what the evidence shows, where. */
export const discrepancySchema = z.object({
  claimed: z.string(),
  shows: z.string(),
  where: z.string(),
});
export type Discrepancy = z.infer<typeof discrepancySchema>;

/**
 * Something the reviewer said it could not check, and what it would need to check it: a digest
 * result or call ("#3"), a workspace file, or something else (`other`, with the reference it names).
 */
export const uncheckedItemSchema = z.object({
  what: z.string(),
  kind: z.enum(["result", "call", "file", "other"]),
  ref: z.string(),
});
export type UncheckedItem = z.infer<typeof uncheckedItemSchema>;

export const contextItemSchema = z.object({ id: z.string(), text: z.string() });
export type ContextItem = z.infer<typeof contextItemSchema>;

/**
 * The moment the run started and the user's time zone (an IANA name), fixed for the whole run.
 * `timeZoneKnown: false` when nobody told the server the user's zone yet (the app sends the zone of
 * the user's computer when it connects): the zone is then UTC and the prompt says so, instead of
 * using the server's own zone in silence (docs/ROTINAS.md).
 */
export const runClockSchema = z.object({
  iso: z.string(),
  timeZone: z.string(),
  timeZoneKnown: z.exactOptional(z.boolean()),
});
export type RunClock = z.infer<typeof runClockSchema>;

/** Another active bot of the user, as the bots tell each other apart: name and what it is for. */
export const teammateSchema = z.object({ name: z.string(), description: z.string() });
export type Teammate = z.infer<typeof teammateSchema>;

/** What the bot's machine is, truthfully, for this run. */
export const machineInfoSchema = z.object({
  /** The bot has a terminal (`shell`). */
  terminal: z.boolean(),
  /** The bot has file tools. */
  files: z.boolean(),
  /** The machine is isolated from the user's own computer (a container). */
  isolated: z.boolean(),
});
export type MachineInfo = z.infer<typeof machineInfoSchema>;

/**
 * The welcome of a bot (docs/RECEPCAO.md): `general` is the one of the main bot (a few questions
 * about the user, then a team proposal); `bot` is the one every other bot has about its own role.
 */
export const RECEPTION_KINDS = ["general", "bot"] as const;
export const receptionKindSchema = z.enum(RECEPTION_KINDS);
export type ReceptionKind = z.infer<typeof receptionKindSchema>;

/**
 * The place of the bot in the team, for the prompt (docs/SUPERVISOR.md): `principal` is the main
 * bot with the supervisor's tools in this run (`team_recall`, `delegate`); `member` is any other bot.
 * Absent when the run is not told (a reception, an evaluation, an older recording).
 */
export const SUPERVISOR_ROLES = ["principal", "member"] as const;
export const supervisorRoleSchema = z.enum(SUPERVISOR_ROLES);
export type SupervisorRole = z.infer<typeof supervisorRoleSchema>;

/**
 * What a run opened by a routine is told about the fire (docs/ROTINAS.md), recorded once in
 * `context_loaded`: which routine, the time it was scheduled for (and its kind: on time, a catch-up
 * after missed times, or "run now"), how many older times were missed, and the routine's own note
 * as it was at the fire. The instruction itself is the run's objective.
 */
export const routineRunFactsSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The schedule in words, for the model (pt-BR, as the user reads it). */
  schedule: z.string(),
  timeZone: z.string(),
  scheduledFor: z.string(),
  kind: z.enum(["scheduled", "catch_up", "manual"]),
  missedCount: z.number().int().nonnegative(),
  state: z.string(),
  /** A one-time reminder the user asked for (not a routine: docs/ROTINAS.md, "Lembrete de uma vez"). */
  reminder: z.exactOptional(z.boolean()),
});
export type RoutineRunFacts = z.infer<typeof routineRunFactsSchema>;

/**
 * The routine a message of the user is about (the app's "Editar" binds it to the draft;
 * docs/ROTINAS.md). It is data of the message, never part of its text: the harness tells the model
 * which routine it is (`renderRoutineRef`), so the bot changes the right one. Recorded with the
 * message (`user_message.routineRef`) or, for the messages that opened the run,
 * `context_loaded.routineRefs`: a resumed run and a replay read the same.
 */
export const routineRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The schedule in words (pt-BR), as the user reads it. */
  schedule: z.string(),
});
export type RoutineRef = z.infer<typeof routineRefSchema>;

/**
 * The bot's own routines as the run starts (docs/ROTINAS.md): name, schedule in words, time zone
 * and state, plus the id for the model. Told to the model in "Your routines", so a new run knows
 * what an earlier run already set up (the history carries text only, not the tool calls behind it).
 * Read once and recorded in `context_loaded.ownRoutines`: a resumed run and a replay read the same.
 */
export const ownRoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The schedule in words (pt-BR), as the user reads it. */
  schedule: z.string(),
  timeZone: z.string(),
  status: z.enum(["active", "paused"]),
  /** A one-time reminder (internal, not in the panel), not a routine (docs/ROTINAS.md). */
  reminder: z.exactOptional(z.boolean()),
});
export type OwnRoutine = z.infer<typeof ownRoutineSchema>;
export const ownRoutinesSchema = z.object({
  items: z.array(ownRoutineSchema),
  /** How many more routines exist beyond the ones listed (the list is capped). */
  more: z.number().int().nonnegative(),
});
export type OwnRoutines = z.infer<typeof ownRoutinesSchema>;

/** Why a pending return was dropped: the user wrote, the run was stopped, a new call replaced it, or the run finished. */
export const WAIT_CANCEL_REASONS = ["user_message", "cancelled", "replaced", "finished"] as const;
export type WaitCancelReason = (typeof WAIT_CANCEL_REASONS)[number];

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  /** Parked by `schedule_return` until `wake_at`: no worker holds it (docs/RETORNO.md). */
  "waiting_timer",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * What opened a run (section 4.1 of the plan). `reception` is the welcome of a bot, which starts on
 * its own the first time the user opens its chat (docs/RECEPCAO.md); like `user`, it is the
 * foreground run of its conversation.
 */
export const RUN_ORIGINS = ["user", "routine", "delegation", "proactive", "reception"] as const;
export const runOriginSchema = z.enum(RUN_ORIGINS);
export type RunOrigin = z.infer<typeof runOriginSchema>;

/**
 * Where a failed run went wrong (section 4.13 of the plan): `provider` the infrastructure or API
 * failed, `model` the model misbehaved (refused, kept stopping without finishing, looped), `tool`
 * a tool failed, `harness` our own bug or a broken invariant, `limit` a configured limit was hit,
 * `approval` an approval was denied, `user` the user ended it.
 */
export const FAILURE_ORIGINS = [
  "provider",
  "model",
  "tool",
  "harness",
  "limit",
  "approval",
  "user",
] as const;
export const failureOriginSchema = z.enum(FAILURE_ORIGINS);
export type FailureOrigin = z.infer<typeof failureOriginSchema>;

/** What a finished run hands back. `evidence` is present when it ended through `finish`. */
export const runResultSchema = z.object({
  summary: z.string(),
  evidence: z.exactOptional(z.array(z.object({ criterion: z.string(), evidence: z.string() }))),
});
export type RunResult = z.infer<typeof runResultSchema>;

/**
 * Which call a model event belongs to. The agent's own turns (the default) build the
 * conversation; `review` and `compaction` calls are recorded in full for auditing but never
 * become part of it.
 */
export const MODEL_CALL_PURPOSES = ["agent", "review", "compaction"] as const;
export const modelCallPurposeSchema = z.enum(MODEL_CALL_PURPOSES);
export type ModelCallPurpose = z.infer<typeof modelCallPurposeSchema>;

export const toolOutcomeSchema = z.enum(TOOL_OUTCOMES);

/**
 * The `type` + `payload` stored in `run_events`. Every model request and response is recorded in
 * full so a run can be audited and replayed without the app or the provider.
 */
export const runEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_started"),
    payload: z.object({
      botId: z.string(),
      objective: z.string(),
      acceptanceCriteria: z.array(z.string()),
      origin: runOriginSchema,
    }),
  }),
  z.object({
    /**
     * What came from outside the loop and shapes this run: the user's standing rules, the shared
     * profile and the earlier turns of the conversation. Loaded ONCE, right after `run_started`,
     * and never again: resume and replay read it from here, so the cached prompt prefix and the
     * conversation stay identical for the whole run.
     */
    type: z.literal("context_loaded"),
    payload: z.object({
      rules: z.array(contextItemSchema),
      profile: z.array(contextItemSchema),
      /** Earlier turns of the same conversation, plain text, as user/assistant messages. */
      history: z.array(messageSchema),
      /** Said alongside the history, e.g. that older messages were left out. */
      historyNote: z.exactOptional(z.string()),
      /** The secrets the bot may use (names and what they are for; never values). */
      secrets: z.exactOptional(z.array(secretInfoSchema)),
      /**
       * When the run started and the user's time zone. Taken ONCE here (never from the clock again),
       * so the system prompt is byte-identical on every request and a replay says the same.
       */
      now: z.exactOptional(runClockSchema),
      /** The other active bots of the user, loaded once per run. */
      team: z.exactOptional(z.array(teammateSchema)),
      /** What the bot's machine is in this run. */
      machine: z.exactOptional(machineInfoSchema),
      /** The names of the connectors granted to the bot (the tools are in the tool index). */
      connectors: z.exactOptional(z.array(z.string())),
      /** Set when the run is a reception: which one. */
      reception: z.exactOptional(receptionKindSchema),
      /** The place of the bot in the team (docs/SUPERVISOR.md). */
      supervisor: z.exactOptional(supervisorRoleSchema),
      /** Set when a routine opened the run: what fired it (docs/ROTINAS.md). */
      routine: z.exactOptional(routineRunFactsSchema),
      /** The routines the messages that opened the run are about (the app's "Editar"). */
      routineRefs: z.exactOptional(z.array(routineRefSchema)),
      /**
       * The bot's own routines when the run started (only in a run that may create routines).
       * Absent in a run recorded before it existed.
       */
      ownRoutines: z.exactOptional(ownRoutinesSchema),
      /**
       * The share of the context window past which this run compacts its history (the user's
       * setting at the start of the run). Recorded so that a replay compacts at the same point.
       * Absent in a run recorded before it existed: the old default (0.7) applies.
       */
      compactionThreshold: z.exactOptional(z.number().min(0.1).max(0.99)),
      /**
       * Rules and profile facts that did not fit under the size cap of what always enters the
       * prompt (`promptLimitItems` memories, default 200, or the `ceilingChars` safety ceiling, 25,000
       * characters) and were left out, in creation order. Nothing is cut silently: this says how
       * much, so the app can ask the user to trim. A run recorded before the limit was counted in
       * memories has `limitChars` instead of `limitItems` and `ceilingChars`: it still parses.
       */
      memoryOmitted: z.exactOptional(
        z.object({
          count: z.number().int().nonnegative(),
          chars: z.number().int().nonnegative(),
          limitItems: z.exactOptional(z.number().int().positive()),
          ceilingChars: z.exactOptional(z.number().int().positive()),
          limitChars: z.exactOptional(z.number().int().positive()),
        }),
      ),
    }),
  }),
  z.object({
    type: z.literal("model_request"),
    payload: z.object({
      /** Provider id (e.g. the adapter's `Provider.id`). */
      provider: z.string(),
      model: z.string(),
      system: z.string(),
      messages: z.array(messageSchema),
      tools: z.array(toolSpecSchema),
      /** Absent means `auto`. */
      toolChoice: z.exactOptional(toolChoiceSchema),
      maxOutputTokens: z.number().int().positive(),
      temperature: z.exactOptional(z.number()),
      purpose: z.exactOptional(modelCallPurposeSchema),
      /** The hosted tool search asked of the provider (the specs marked `deferLoading` are searched). */
      hostedToolSearch: z.exactOptional(z.enum(["bm25", "regex"])),
      /** What the tool definitions of this request cost (estimated); see `toolDefinitionStats`. */
      toolStats: z.exactOptional(toolStatsSchema),
    }),
  }),
  z.object({
    type: z.literal("model_response"),
    payload: z.object({
      blocks: z.array(blockSchema),
      stopReason: stopReasonSchema,
      usage: usageSchema,
      modelVersion: z.string(),
      durationMs: z.number().nonnegative(),
      purpose: z.exactOptional(modelCallPurposeSchema),
      /**
       * The estimate of this request's input beside the real count (`usage.inputTokens`), so the
       * estimate can be judged: `estimatedTokens` for the whole input, `definitionTokens` for the
       * tool definitions alone. With `hostedToolSearch` the provider ran the search itself in
       * internal passes and `usage` SUMS them: it is not the size of one request.
       */
      measure: z.exactOptional(
        z.object({
          estimatedTokens: z.number().int().nonnegative(),
          definitionTokens: z.number().int().nonnegative(),
          hostedToolSearch: z.exactOptional(z.enum(["bm25", "regex"])),
        }),
      ),
    }),
  }),
  z.object({
    type: z.literal("model_error"),
    payload: z.object({
      kind: z.enum(PROVIDER_ERROR_KINDS),
      message: z.string(),
      retryable: z.boolean(),
      /** 1-based attempt number at the loop level. */
      attempt: z.number().int().positive(),
      purpose: z.exactOptional(modelCallPurposeSchema),
    }),
  }),
  z.object({
    type: z.literal("tool_call"),
    payload: z.object({ callId: z.string(), name: z.string(), args: z.json() }),
  }),
  z.object({
    type: z.literal("tool_result"),
    payload: z.object({
      callId: z.string(),
      outcome: toolOutcomeSchema,
      content: z.string(),
      isError: z.boolean(),
      truncated: z.boolean(),
      durationMs: z.number().nonnegative(),
      /** Set on the answer to an `escalate` call: the inbox items this result delivers. */
      inboxIds: z.exactOptional(z.array(z.string())),
      /** Set on the answer to `search_tools` with client-side tool search: the tools it loads. */
      toolReferences: z.exactOptional(z.array(z.string())),
      /**
       * The URLs (normalized) this result put in front of the model: the hits of a `web_search`, the
       * links of a page read with `web_read`. From the next call on `web_read` may open them without
       * a card (docs/BUSCA.md). Part of the log so a replay clears the same addresses.
       */
      webUrls: z.exactOptional(z.array(z.string())),
      /** `web_read`: how the address was cleared (`approved`: the user said yes on a card). */
      urlProvenance: z.exactOptional(
        z.enum(["user_message", "search_result", "page_link", "approved"]),
      ),
      /** The page this result is, as the tool declared it (`web_read`): a source of the run. */
      source: z.exactOptional(z.object({ url: z.string(), title: z.exactOptional(z.string()) })),
    }),
  }),
  z.object({
    /**
     * The verdict of the approval policy on a call that was neither plainly allowed as a read nor
     * sent to the user: allowed or denied by a rule, the reviewer, or the default of its level.
     * A resumed or replayed run reads it instead of deciding again.
     */
    type: z.literal("policy_checked"),
    payload: z.object({
      callId: z.string(),
      tool: z.string(),
      level: riskLevelSchema,
      outcome: z.enum(["allow", "deny"]),
      source: policySourceSchema,
      /** The exact rule that decided. */
      ruleId: z.exactOptional(z.string()),
      /** The rule the user WROTE that the model reviewer rests on (see `approval_review`). */
      writtenRuleId: z.exactOptional(z.string()),
      reason: z.exactOptional(z.string()),
    }),
  }),
  z.object({
    /**
     * The model reviewer looked at a call (auto-review mode): what it said, what the harness made
     * of it, and what it cost. Written BEFORE the `policy_checked` or `approval_requested` of the
     * same call; a resumed or replayed run reads it and never asks the model again.
     */
    type: z.literal("approval_review"),
    payload: approvalReviewSchema,
  }),
  z.object({
    /**
     * A call waits for the user. `args` is EXACTLY what will run if it is approved (the secret
     * placeholders as the model wrote them, never values); the call is not executed until an
     * `approval_decided` says so.
     */
    type: z.literal("approval_requested"),
    payload: z.object({
      approvalId: z.string(),
      callId: z.string(),
      tool: z.string(),
      args: z.json(),
      level: riskLevelSchema,
      /** One line for the card. */
      summary: z.string(),
      /** The secret names the call uses. */
      secrets: z.array(z.string()),
      source: policySourceSchema,
      /** Present only when the tool declares the call as a message to another person. */
      outbound: z.exactOptional(outboundMessageSchema),
      /** Present only when a configured limit makes the request expire. */
      expiresAt: z.exactOptional(z.string()),
      /** Why the user is asked, when the reviewer or a floor said so (one short sentence). */
      reason: z.exactOptional(z.string()),
      /** The written rule behind that reason, when there is one. */
      writtenRuleId: z.exactOptional(z.string()),
    }),
  }),
  z.object({
    type: z.literal("approval_decided"),
    payload: z.object({
      approvalId: z.string(),
      callId: z.string(),
      decision: approvalDecisionSchema,
      /** The user's reason for a denial. */
      reason: z.exactOptional(z.string()),
      /** The rule an "approve and always allow" created. */
      ruleId: z.exactOptional(z.string()),
    }),
  }),
  z.object({
    /**
     * An approved card waited longer than the staleness limit (`approvals.staleAfterMinutes`, kept
     * by the server). Written right after the `approval_decided` that approved it, from numbers the
     * store recorded when the user decided: `waitedMs` and the `thresholdMs` it was measured
     * against. The call is NOT run: the model is told, and the approval stays as a one-time grant
     * for the identical call within this run (`approval_grant_used`).
     */
    type: z.literal("approval_stale"),
    payload: z.object({
      approvalId: z.string(),
      callId: z.string(),
      waitedMs: z.number().int().nonnegative(),
      thresholdMs: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    /**
     * A call identical (same tool, same arguments, compared exactly) to one approved late ran
     * without a new card, consuming that approval's grant. `callId` is the NEW call.
     */
    type: z.literal("approval_grant_used"),
    payload: z.object({
      approvalId: z.string(),
      callId: z.string(),
      tool: z.string(),
    }),
  }),
  z.object({
    /** The bot asks the user for a credential; the answer is only that it is now available. */
    type: z.literal("secret_requested"),
    payload: z.object({
      callId: z.string(),
      name: z.string(),
      reason: z.exactOptional(z.string()),
    }),
  }),
  z.object({
    type: z.literal("plan_updated"),
    payload: z.object({ plan: z.array(planStepSchema) }),
  }),
  z.object({
    /** A user message delivered to the loop at a safe point (between turns). */
    type: z.literal("user_message"),
    payload: z.object({
      text: z.string(),
      /** The inbox item this event delivers. A resumed loop never delivers the same id twice. */
      inboxId: z.exactOptional(z.string()),
      /**
       * The card the user had just denied, when this message was delivered after that denial and
       * before the model's next request (decided by the order of the log, never by the text).
       * The model reads the message as being about that denied action.
       */
      linkedApprovalId: z.exactOptional(z.string()),
      /** The routine the message is about (the app's "Editar"); never in `text`. */
      routineRef: z.exactOptional(routineRefSchema),
    }),
  }),
  z.object({
    /** The harness telling the model to keep going (e.g. pending plan steps remain). */
    type: z.literal("nudge"),
    payload: z.object({ reason: z.string(), text: z.string() }),
  }),
  z.object({
    type: z.literal("finish_attempt"),
    payload: z.object({
      /** The `finish` call this attempt answers. */
      callId: z.exactOptional(z.string()),
      summary: z.string(),
      /** Evidence per acceptance criterion. */
      evidence: z.array(z.object({ criterion: z.string(), evidence: z.string() })),
      accepted: z.boolean(),
      rejectionReasons: z.array(z.string()),
      /** Not accepted, and the decision was handed to the user (the review kept rejecting). */
      handedToUser: z.exactOptional(z.boolean()),
      /**
       * Not accepted, and the run ends failed with this (a routine's run, which nobody answers
       * live, whose review could not verify the work or failed): the loop closes it at the next
       * safe point, so a resumed or replayed run ends the same way.
       */
      endsRun: z.exactOptional(z.object({ origin: failureOriginSchema, detail: z.string() })),
      /**
       * Not accepted because the reviewer could not verify it, and sent back to the bot ONCE with
       * the reviewer's notes to produce the evidence (the next unverified goes to the owner).
       */
      sentBack: z.exactOptional(z.boolean()),
    }),
  }),
  z.object({
    type: z.literal("review"),
    payload: z.object({
      /**
       * `unverified`: after the evidence rounds the reviewer still could not check something. It
       * is neither an approval nor a rejection of the work: the decision goes to the owner, and
       * `notes` says exactly what could not be verified.
       */
      verdict: z.enum(["approve", "reject", "unverified"]),
      notes: z.string(),
      /**
       * Logs written before 23/11/2026 only: the review did not really happen and the verdict was an
       * approval by default. Today such a review is `unverified` with `failed`.
       */
      warning: z.exactOptional(z.string()),
      /** `reject`: the concrete discrepancies the reviewer named (at least one; else not a reject). */
      discrepancies: z.exactOptional(z.array(discrepancySchema).min(1)),
      /** `unverified`: what the reviewer listed as unchecked and not already sent to it in full. */
      unchecked: z.exactOptional(z.array(uncheckedItemSchema)),
      /**
       * `unverified` from a `cannot_verify` that, even after being asked once more, named nothing
       * the harness had not already sent in full (or nothing at all): the owner is told so.
       */
      namedNothing: z.exactOptional(z.boolean()),
      /**
       * `unverified` because the review did not happen ("a revisão falhou"): the reviewer could not
       * be reached even after one more try (`provider`), or answered without a usable verdict
       * (`model`). Never an approval: a user's run asks the owner, a routine's run ends failed.
       */
      failed: z.exactOptional(z.enum(["provider", "model"])),
      /**
       * `unverified` because the reviewer lacked evidence it named (still asking after the evidence
       * rounds, or a `cannot_verify` listing what it lacks): evidence the bot may still produce, so
       * the first such finish goes back to the bot with these notes before the owner is asked.
       */
      missingEvidence: z.exactOptional(z.boolean()),
    }),
  }),
  z.object({
    /**
     * The reviewer's answer was not usable and the harness asked once more (this event is that
     * question): a `reject` with no discrepancy marked as a real mismatch, or a `cannot_verify` that
     * named nothing it lacked (or only what had already been sent in full). `args` is what the
     * reviewer sent, so the conversation can be rebuilt. A second unusable answer ends the review
     * as `unverified`.
     */
    type: z.literal("review_reprompt"),
    payload: z.object({
      callId: z.string(),
      args: z.json(),
      reason: z.string(),
    }),
  }),
  z.object({
    /**
     * The reviewer asked for evidence it could not see in the digest, and the harness supplied it
     * (one event per round). Tool results are named by `ref` (the call id): their content is
     * already in the log, so it is not copied here. Files are not in the log, so their content is
     * kept (that is what makes a resumed or replayed review identical).
     */
    type: z.literal("review_evidence"),
    payload: z.object({
      /** 1-based round of this review. */
      round: z.number().int().positive(),
      /** The reviewer's `verdict` tool call that asked, so the conversation can be rebuilt. */
      callId: z.string(),
      /** Why the reviewer wanted it, in its words. */
      notes: z.string(),
      /** What the reviewer named: digest entries (`#3` or a call id) and workspace paths. */
      requested: z.object({
        results: z.array(z.string()),
        files: z.array(z.string()),
        /** Tool CALLS whose full arguments were asked for (absent in older logs: none). */
        calls: z.exactOptional(z.array(z.string())),
      }),
      /** What was supplied, in order. `sent` is how many characters were shown (the budget). */
      supplied: z.array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("tool_result"),
            /** The tool call id; the full content is that call's `tool_result` event. */
            ref: z.string(),
            /** Position in the digest (1-based). */
            index: z.number().int().positive(),
            chars: z.number().int().nonnegative(),
            sent: z.number().int().nonnegative(),
          }),
          z.object({
            kind: z.literal("tool_call"),
            /** The tool call id; the arguments are that call's `tool_call` event, rendered. */
            ref: z.string(),
            index: z.number().int().positive(),
            chars: z.number().int().nonnegative(),
            sent: z.number().int().nonnegative(),
          }),
          z.object({
            kind: z.literal("file"),
            ref: z.string(),
            chars: z.number().int().nonnegative(),
            sent: z.number().int().nonnegative(),
            /** A short fingerprint of the whole content (not cryptographic). */
            hash: z.string(),
            /** The whole text read, so that resume and replay do not depend on the disk. */
            content: z.string(),
          }),
        ]),
      ),
      /** Requested items that could not be supplied, and why. */
      missing: z.array(
        z.object({
          item: z.string(),
          reason: z.string(),
          /** What else the reviewer can try (for example: the content may be a call's arguments). */
          hint: z.exactOptional(z.string()),
        }),
      ),
      /** Requested items left out only because the budget ran out (absent in older logs: none). */
      omitted: z.exactOptional(z.array(z.object({ item: z.string(), chars: z.number().int() }))),
      /** The most characters of evidence the harness shows in one round. */
      budgetChars: z.number().int().positive(),
    }),
  }),
  z.object({
    type: z.literal("escalated"),
    payload: z.object({
      question: z.string(),
      /**
       * What was asked, when it is more than one plain question (choices, several questions). Its
       * text is `question`: the question itself, or the numbered list of them.
       */
      questions: z.exactOptional(z.array(escalateQuestionSchema).min(1).max(5)),
      /** The `escalate` call this question came from. Absent for a review tie-break. */
      callId: z.exactOptional(z.string()),
      /**
       * What the bot wrote in the same turn, besides the question (context, a short reason). The
       * chat shows it as the bot's message above the card; the question is the card's title.
       * Absent when the bot only called the tool.
       */
      lead: z.exactOptional(z.string()),
      /** `review_tie_break`: the reviewer rejected too often and a human must decide. */
      reason: z.exactOptional(z.enum(["review_tie_break"])),
      /**
       * With `review_tie_break`: why the review sent it to the user. `reject`: the bot and the
       * reviewer disagree. `unverified`: the reviewer could not verify part of the work. Absent in
       * older logs (read as `reject`).
       */
      reviewVerdict: z.exactOptional(z.enum(["reject", "unverified"])),
    }),
  }),
  z.object({
    /**
     * How the run offers the tools of its connectors (all loaded, or deferred and found by search).
     * Decided ONCE, right after `context_loaded`, from the tools granted to the bot at that moment:
     * resume and replay read it from here, so the tools of every request of the run stay the same
     * (byte for byte) and the prompt cache holds. Absent in runs without connector tools.
     */
    type: z.literal("tool_catalog"),
    payload: toolCatalogSchema,
  }),
  z.object({
    type: z.literal("status_changed"),
    payload: z.object({
      from: runStatusSchema,
      to: runStatusSchema,
      failure: z.exactOptional(z.object({ origin: failureOriginSchema, detail: z.string() })),
      result: z.exactOptional(runResultSchema),
      /** Set when the change is a cancellation asked for through the inbox (the `stop` items). */
      inboxIds: z.exactOptional(z.array(z.string())),
    }),
  }),
  z.object({
    /**
     * The bot asked to come back by itself (`schedule_return`). `at` is the instant, ISO 8601, fixed
     * when the call was made (so a resumed or replayed run never recomputes it). One pending return
     * per run: a second call logs `wait_cancelled` (`replaced`) and then a new `wait_scheduled`.
     */
    type: z.literal("wait_scheduled"),
    payload: z.object({
      at: z.string(),
      note: z.string(),
      minutes: z.number().int().positive(),
      /** The `schedule_return` call that asked for it (a resumed run does not log it twice). */
      callId: z.exactOptional(z.string()),
    }),
  }),
  z.object({
    /**
     * The return came due. Written by the database job that wakes the run, in the same transaction
     * that makes the run claimable again (so it is written exactly once); the resumed loop reads
     * it and tells the model. `delayMs` is how late it fired (a worker that was down): it fires once.
     */
    type: z.literal("wait_fired"),
    payload: z.object({
      at: z.string(),
      note: z.string(),
      delayMs: z.exactOptional(z.number().int().nonnegative()),
    }),
  }),
  z.object({
    /** The pending return will not fire: why. */
    type: z.literal("wait_cancelled"),
    payload: z.object({ reason: z.enum(WAIT_CANCEL_REASONS) }),
  }),
  z.object({
    type: z.literal("compacted"),
    payload: z.object({
      /** Replaces every message built from events up to and including `uptoSeq`. */
      summary: z.string(),
      uptoSeq: z.number().int().nonnegative(),
      droppedMessages: z.number().int().nonnegative(),
      /** The summarizing call failed and the oldest messages were dropped with a stub note. */
      degraded: z.exactOptional(z.boolean()),
      warning: z.exactOptional(z.string()),
    }),
  }),
]);

export type RunEventData = z.infer<typeof runEventSchema>;
export type RunEventType = RunEventData["type"];
/** Payload type of one event type, e.g. `RunEventPayload<"tool_call">`. */
export type RunEventPayload<T extends RunEventType> = Extract<RunEventData, { type: T }>["payload"];

export const RUN_EVENT_TYPES = runEventSchema.options.map(
  (option) => option.shape.type.value,
) as RunEventType[];

/** Validates a stored `(type, payload)` pair. Throws a `ZodError` if it does not match. */
export function parseRunEvent(type: string, payload: unknown): RunEventData {
  return runEventSchema.parse({ type, payload });
}
