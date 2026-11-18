import { z } from "zod";
import { blockSchema, messageSchema } from "./messages.js";
import { PROVIDER_ERROR_KINDS, stopReasonSchema, toolSpecSchema, usageSchema } from "./provider.js";
import { TOOL_OUTCOMES } from "./registry.js";

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  note: z.exactOptional(z.string()),
});
export type PlanStep = z.infer<typeof planStepSchema>;

const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
]);

const failureOriginSchema = z.enum(["provider", "tool", "harness", "limit", "approval", "user"]);

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
      origin: z.enum(["user", "routine", "delegation", "proactive"]),
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
      maxOutputTokens: z.number().int().positive(),
      temperature: z.exactOptional(z.number()),
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
    }),
  }),
  z.object({
    type: z.literal("plan_updated"),
    payload: z.object({ plan: z.array(planStepSchema) }),
  }),
  z.object({
    /** A user message delivered to the loop at a safe point (between turns). */
    type: z.literal("user_message"),
    payload: z.object({ text: z.string() }),
  }),
  z.object({
    /** The harness telling the model to keep going (e.g. pending plan steps remain). */
    type: z.literal("nudge"),
    payload: z.object({ reason: z.string(), text: z.string() }),
  }),
  z.object({
    type: z.literal("finish_attempt"),
    payload: z.object({
      summary: z.string(),
      /** Evidence per acceptance criterion. */
      evidence: z.array(z.object({ criterion: z.string(), evidence: z.string() })),
      accepted: z.boolean(),
      rejectionReasons: z.array(z.string()),
    }),
  }),
  z.object({
    type: z.literal("review"),
    payload: z.object({ verdict: z.enum(["approve", "reject"]), notes: z.string() }),
  }),
  z.object({
    type: z.literal("escalated"),
    payload: z.object({ question: z.string() }),
  }),
  z.object({
    type: z.literal("status_changed"),
    payload: z.object({
      from: runStatusSchema,
      to: runStatusSchema,
      failure: z.exactOptional(z.object({ origin: failureOriginSchema, detail: z.string() })),
    }),
  }),
  z.object({
    type: z.literal("compacted"),
    payload: z.object({ summary: z.string(), droppedEvents: z.number().int().nonnegative() }),
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
