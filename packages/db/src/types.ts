import { z } from "zod";

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ORIGINS = ["user", "routine", "delegation", "proactive"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export const FAILURE_ORIGINS = [
  "provider",
  "tool",
  "harness",
  "limit",
  "approval",
  "user",
] as const;
export type FailureOrigin = (typeof FAILURE_ORIGINS)[number];

/** Statuses in which a run is finished: `finished_at` is set and the lease is cleared. */
export const TERMINAL_RUN_STATUSES = ["done", "failed", "cancelled"] as const;

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  note: z.exactOptional(z.string()),
});
export type PlanStep = z.infer<typeof planStepSchema>;
export const planSchema = z.array(planStepSchema);

export const acceptanceCriteriaSchema = z.array(z.string());

/** Per-bot limits. Unknown keys are kept, so later phases can add limits without a migration. */
export const botLimitsSchema = z.looseObject({
  maxTurns: z.exactOptional(z.number().int().positive()),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(z.number().int().positive()),
});
export type BotLimits = z.infer<typeof botLimitsSchema>;

export const eventPayloadSchema = z.record(z.string(), z.json());
export type JsonValue = z.infer<typeof z.json>;
export type EventPayload = z.infer<typeof eventPayloadSchema>;

export interface Bot {
  id: string;
  name: string;
  description: string;
  personality: string;
  modelProvider: string;
  modelId: string;
  allowedTools: string[];
  limits: BotLimits;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Run {
  id: string;
  botId: string;
  parentRunId: string | null;
  origin: RunOrigin;
  objective: string;
  acceptanceCriteria: string[];
  plan: PlanStep[];
  status: RunStatus;
  failureOrigin: FailureOrigin | null;
  failureDetail: string | null;
  result: JsonValue | null;
  turns: number;
  /** `bigint` column, deliberately mapped to a JS number (safe up to 2^53 - 1 tokens). */
  inputTokens: number;
  /** `bigint` column, deliberately mapped to a JS number (safe up to 2^53 - 1 tokens). */
  outputTokens: number;
  /** `numeric(12,6)` column, deliberately kept as a decimal string (e.g. "0.012300") to avoid float drift. */
  costUsd: string;
  traceId: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface RunEvent {
  /** Global identity of the row (`bigint` column mapped to a JS number). */
  id: number;
  runId: string;
  /** Position inside the run, starting at 1, without gaps. */
  seq: number;
  type: string;
  payload: EventPayload;
  createdAt: Date;
}
