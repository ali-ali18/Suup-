import { z } from "zod";
import { blockSchema, messageSchema } from "./messages.js";
import {
  PROVIDER_ERROR_KINDS,
  stopReasonSchema,
  toolChoiceSchema,
  toolSpecSchema,
  usageSchema,
} from "./provider.js";
import { TOOL_OUTCOMES } from "./registry.js";

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

export const contextItemSchema = z.object({ id: z.string(), text: z.string() });
export type ContextItem = z.infer<typeof contextItemSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** What opened a run (section 4.1 of the plan). */
export const RUN_ORIGINS = ["user", "routine", "delegation", "proactive"] as const;
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
    }),
  }),
  z.object({
    type: z.literal("review"),
    payload: z.object({
      verdict: z.enum(["approve", "reject"]),
      notes: z.string(),
      /**
       * Set when the review did not really happen (reviewer unreachable, answer malformed): the
       * verdict is then an approval by default and this says why.
       */
      warning: z.exactOptional(z.string()),
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
      /** `review_tie_break`: the reviewer rejected too often and a human must decide. */
      reason: z.exactOptional(z.enum(["review_tie_break"])),
    }),
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
