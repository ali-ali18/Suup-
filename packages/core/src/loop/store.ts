import type { FailureOrigin, PlanStep, RunEventData, RunResult, RunStatus } from "../events.js";

export type { FailureOrigin, RunResult, RunStatus };

export type RunOrigin = "user" | "routine" | "delegation" | "proactive";

/** The run as the store knows it. The conversation is NOT here: it is rebuilt from events. */
export interface RunRecord {
  id: string;
  botId: string;
  objective: string;
  acceptanceCriteria: string[];
  /** Mirror of the last `plan_updated` event, kept for readers that do not replay events. */
  plan: PlanStep[];
  status: RunStatus;
  origin: RunOrigin;
  /** Model calls made by the agent so far (reviewer and compaction calls are not turns). */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: Date;
  /** When the run first started working; the duration limit is measured from here. */
  startedAt: Date;
}

/** An event as stored: the data plus the position and time the store gave it. */
export type StoredEvent = RunEventData & { seq: number; createdAt: Date };

/** Something posted to a run from outside while it works. Each item is delivered once. */
export type InboxItem = { kind: "user_message"; text: string } | { kind: "stop" };

export interface UsageDelta {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface StatusChange {
  /** The change applies only if the current status is one of these (compare-and-set). */
  from: RunStatus[];
  to: RunStatus;
  /** Only with `to: "failed"`. */
  failure?: { origin: FailureOrigin; detail: string };
  /** Only with `to: "done"`. */
  result?: RunResult;
}

/**
 * The only persistence the loop knows. The Postgres implementation adapts this to `packages/db`.
 *
 * Contract notes for implementers:
 * - `appendEvent` is append-only and assigns increasing `seq` values per run.
 * - `drainInbox` must be safe against a crash between returning items and the loop recording them
 *   as events: an implementation backed by a database should only treat an item as consumed once
 *   the matching `user_message` event exists (or hand unacknowledged items out again). The
 *   in-memory store simply removes them.
 */
export interface RunStore {
  getRun(runId: string): Promise<RunRecord>;
  appendEvent(runId: string, event: RunEventData): Promise<{ seq: number }>;
  /** All events of the run in `seq` order. */
  listEvents(runId: string): Promise<StoredEvent[]>;
  /** Compare-and-set. Returns false (and changes nothing) when the current status is not in `from`. */
  setStatus(runId: string, change: StatusChange): Promise<boolean>;
  updatePlan(runId: string, plan: PlanStep[]): Promise<void>;
  addUsage(runId: string, usage: UsageDelta): Promise<void>;
  drainInbox(runId: string): Promise<InboxItem[]>;
  /** Renews the worker's lease on the run. */
  heartbeat(runId: string): Promise<void>;
}
