import { z } from "zod";
import { csvQuery, intQuery, isoDate, jsonRecord, page, uuid } from "./common.js";

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const RUN_ORIGINS = ["user", "routine", "delegation", "proactive"] as const;
export const FAILURE_ORIGINS = [
  "provider",
  "model",
  "tool",
  "harness",
  "limit",
  "approval",
  "user",
] as const;

/** Every `type` a run event can have (the log of `docs/FRONTEND.md`, section 5). */
export const RUN_EVENT_TYPES = [
  "run_started",
  "context_loaded",
  "model_request",
  "model_response",
  "model_error",
  "tool_call",
  "tool_result",
  "plan_updated",
  "user_message",
  "nudge",
  "finish_attempt",
  "review",
  "review_evidence",
  "review_reprompt",
  "escalated",
  "tool_catalog",
  "status_changed",
  "compacted",
  "policy_checked",
  "approval_requested",
  "approval_decided",
  "secret_requested",
] as const;
export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  note: z.string().optional(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const runResultSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.object({ criterion: z.string(), evidence: z.string() })).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

export const runSchema = z.object({
  id: uuid,
  botId: uuid,
  parentRunId: uuid.nullable(),
  conversationId: uuid.nullable(),
  origin: z.enum(RUN_ORIGINS),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  plan: z.array(planStepSchema),
  status: runStatusSchema,
  /**
   * The user paused the run (`pause` or `interrupt`). With `status` `queued` it is stopped and
   * waits for `resume`; with `running` it is on its way to stopping.
   */
  paused: z.boolean(),
  failureOrigin: z.enum(FAILURE_ORIGINS).nullable(),
  failureDetail: z.string().nullable(),
  result: runResultSchema.nullable(),
  turns: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** A decimal as text, e.g. `"0.034100"`, so money never goes through a float. */
  costUsd: z.string(),
  traceId: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const listRunsQuerySchema = z.object({
  conversationId: uuid.optional(),
  botId: uuid.optional(),
  status: runStatusSchema.optional(),
  /** Only runs created before this instant (to go further back). */
  before: isoDate.optional(),
  limit: intQuery(1, 200).default(50),
});
export interface ListRunsQuery {
  conversationId?: string;
  botId?: string;
  status?: RunStatus;
  /** Only runs created before this instant (ISO 8601). */
  before?: string;
  limit?: number;
}
export const runListSchema = page(runSchema);

/** An event of the log. `payload` depends on `type`: see `docs/FRONTEND.md`, section 5. */
export const runEventSchema = z.object({
  seq: z.number().int(),
  type: z.string(),
  createdAt: isoDate,
  payload: jsonRecord,
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const RUN_EVENT_VIEWS = ["full", "chat"] as const;
export const runEventsQuerySchema = z.object({
  afterSeq: intQuery(0, Number.MAX_SAFE_INTEGER).default(0),
  limit: intQuery(1, 1000).default(200),
  types: csvQuery.pipe(z.array(runEventTypeSchema)).optional(),
  /**
   * `chat` leaves out what the chat never draws and can be huge: the `model_request` payload
   * becomes `{ omitted: true, provider, model, purpose, messageCount, toolCount, toolStats? }` (the whole
   * request is in `GET /v1/runs/{id}/requests/{seq}`). Everything else is kept. Default `full`.
   */
  view: z.enum(RUN_EVENT_VIEWS).default("full"),
});
export interface RunEventsQuery {
  afterSeq?: number;
  limit?: number;
  types?: RunEventType[];
  view?: (typeof RUN_EVENT_VIEWS)[number];
}
export const runEventsSchema = z.object({
  items: z.array(runEventSchema),
  /** More events exist after the last one returned. */
  hasMore: z.boolean(),
  /** The `seq` to ask for next (`afterSeq`): the last one returned, or the one asked for. */
  lastSeq: z.number().int(),
});
export type RunEvents = z.infer<typeof runEventsSchema>;
