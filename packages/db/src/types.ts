// The vocabulary of a run (statuses, origins, failure origins, plan steps) belongs to `core`: it is
// what the loop writes. The database only mirrors it in check constraints, and the tests keep the
// two in step.
import {
  FAILURE_ORIGINS,
  type FailureOrigin,
  type PlanStep,
  planStepSchema,
  RUN_ORIGINS,
  type RunOrigin,
  type RunStatus,
  runStatusSchema,
} from "@suup/core";
import { z } from "zod";

export type { FailureOrigin, PlanStep, RunOrigin, RunStatus };
export { FAILURE_ORIGINS, planStepSchema, RUN_ORIGINS };

export const RUN_STATUSES = runStatusSchema.options;

/** Statuses in which a run is finished: `finished_at` is set and the lease is cleared. */
export const TERMINAL_RUN_STATUSES = ["done", "failed", "cancelled"] as const;

export const planSchema = z.array(planStepSchema);

export const acceptanceCriteriaSchema = z.array(z.string());

/** Per-bot limits. Unknown keys are kept, so later phases can add limits without a migration. */
export const botLimitsSchema = z.looseObject({
  maxTurns: z.exactOptional(z.number().int().positive()),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(z.number().int().positive()),
  /** Consecutive returns one run may schedule for itself (`schedule_return`); default 6. */
  maxReturns: z.exactOptional(z.number().int().nonnegative()),
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
  /**
   * Always present on bots read through this package. Declared optional only so the code that
   * builds `Bot`/`Run` values by hand (fixtures in other packages) keeps compiling; tighten it
   * once those are updated.
   * Opaque reference (the app decides how to read it: emoji, file id, URL, ...). */
  avatar?: string | null;
  /** The "main" bot: receives messages when none is chosen. At most one active bot has it. */
  isDefault?: boolean;
  /** Pinned at the top of the bots list. (Optional for the same reason as `avatar`.) */
  pinned?: boolean;
  /** The group the bot is listed under; `null` for the default list. */
  groupName?: string | null;
  /** Position inside its block (pinned, or its group); `null` sorts last. */
  sortOrder?: number | null;
  /** An id of the palette of `@suup/api` (the server validates it); `null` for the mascot's own. */
  color?: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Run {
  id: string;
  botId: string;
  parentRunId: string | null;
  /** The conversation whose message opened this run; `null` for routine/delegated runs. */
  conversationId?: string | null;
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
  /**
   * Set while the user has the run paused: no worker takes it from the queue until it is resumed.
   * A run still `running` with this set is on its way to stopping (the worker obeys at the next
   * safe point, or at once after an interrupt). Always present on runs read through this package.
   */
  pausedAt?: Date | null;
  /** A hard interrupt was asked for and the worker holding the run has not obeyed it yet. */
  interruptRequestedAt?: Date | null;
  /**
   * An evaluation run (`suup eval`): it never reads the user's memory and never writes to it, not
   * even the journal entry at its end. Always present on runs read through this package.
   */
  isolated?: boolean;
  /** While `waiting_timer`: when the run is woken, and the note it left itself. Always present on runs read through this package. */
  wakeAt?: Date | null;
  wakeNote?: string | null;
  /** Returns that fired in a row since the user last wrote to the run. */
  wakeCount?: number;
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
