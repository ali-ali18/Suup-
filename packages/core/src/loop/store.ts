import type {
  ApprovalDecision,
  FailureOrigin,
  PlanStep,
  RunEventData,
  RunOrigin,
  RunResult,
  RunStatus,
} from "../events.js";

export type { FailureOrigin, RunOrigin, RunResult, RunStatus };

/**
 * What the user (or the system) decided about an approval, as the store holds it before the loop
 * records it in the log as `approval_decided`.
 */
export interface ApprovalDecisionItem {
  approvalId: string;
  callId: string;
  decision: ApprovalDecision;
  reason?: string | undefined;
  /** The rule an "approve and always allow" created. */
  ruleId?: string | undefined;
}

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
  /** Model calls made by the agent so far, plus the extra calls of the reviewer's evidence rounds (the first review call and compaction calls are not turns). */
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

/** What the server posts to a run from outside while it works. */
export type InboxItemInput = { kind: "user_message"; text: string } | { kind: "stop" };

/**
 * A posted item as the loop sees it. `id` is assigned by the store when the item is posted and
 * stays the same however many times the item is peeked.
 */
export type InboxItem = InboxItemInput & { id: string };

/**
 * Thrown by a store when the worker no longer holds the lease on a run (it was presumed dead and
 * another worker took the run over). `runLoop` lets it through untouched: the loop stops at once
 * and writes nothing more, so two workers never write to the same run.
 */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  constructor(
    readonly runId: string,
    detail = "the lease on the run is no longer held by this worker",
  ) {
    super(`${detail} (run ${runId})`);
  }
}

/**
 * What the user asked of a run from outside the worker (the server writes it to the database; see
 * `heartbeat`). Both flags are level-triggered: they stay true until the run is resumed or taken
 * over, so a request is never lost between two heartbeats.
 */
export interface RunControl {
  /** Stop at the next safe point, without starting another model call (a soft pause). */
  pause: boolean;
  /**
   * Stop now: abort the model call and the tool in flight. The worker acts on it (the loop does
   * not read it): it is what the heartbeat tick looks at, so a hard interrupt reaches a run that
   * sits in a long model or tool call.
   */
  interrupt: boolean;
}

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
  /**
   * Only with `to: "waiting_user"` or `"waiting_timer"`, set by the loop when it pauses for the user
   * (or parks for a return of its own). If an inbox item
   * is already pending (posted after the loop last looked, so the post did not see a waiting
   * run), the store must not leave the run waiting for ever: it makes the run claimable again
   * (status `queued`, lease cleared) instead. The item and the pause are then serialized by the
   * store, whichever comes first. The change still reports `true`.
   */
  requeueIfInbox?: boolean;
  /**
   * Only with `to: "waiting_approval"`, the same idea as `requeueIfInbox`: if an approval of the
   * run was already decided (and not yet recorded in the log), the store must not leave the run
   * waiting for ever; it makes the run claimable again instead. The change still reports `true`.
   */
  requeueIfDecided?: boolean;
  /**
   * Only with `to: "waiting_timer"`: when the run is to be woken (ISO 8601), the note it left
   * itself and how many returns have fired since the user last wrote. The store keeps them with
   * the run so the job that wakes runs can find the due ones; they are cleared on leaving the status.
   */
  wake?: { at: string; note: string; count: number };
}

/**
 * The only persistence the loop knows. The Postgres implementation adapts this to `packages/db`.
 *
 * Contract notes for implementers:
 * - `appendEvent` is append-only and assigns increasing `seq` values per run.
 * - The inbox is two-phase. `peekInbox` returns the items not acknowledged yet, oldest first,
 *   WITHOUT consuming them: peeking twice gives the same items with the same ids. The loop calls
 *   `ackInbox` only after the events that deliver the items are recorded (`user_message`, the
 *   answer to `escalate`, or the cancellation), and those events carry the item ids. A crash in
 *   between therefore never loses an item, and the next loop sees the ids in the log, acks the
 *   items and does not deliver them again. `ackInbox` is idempotent and ignores unknown ids.
 * - Approvals work like the inbox. The loop logs `approval_requested` (the store keeps the request
 *   for the user to see); the decision is made from outside and held by the store;
 *   `peekApprovalDecisions` returns the decisions not yet recorded in the log (the same ones on
 *   every call), and the loop calls `ackApprovalDecisions` only after the `approval_decided` events
 *   exist. A decision posted to a run in `waiting_approval` makes it claimable again.
 * - `heartbeat` renews the worker's lease and throws `LeaseLostError` when it is no longer held.
 *   A store that fences writes may throw it from any other method too. It returns what the user
 *   asked of the run meanwhile (`RunControl`); a store with no outside control returns nothing.
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
  /** Items not acknowledged yet, oldest first. Does not consume them. */
  peekInbox(runId: string): Promise<InboxItem[]>;
  /** Marks items as delivered. Idempotent. Call it only after the delivering events exist. */
  ackInbox(runId: string, ids: readonly string[]): Promise<void>;
  /** Decisions made from outside that the log does not hold yet, oldest first. Does not consume them. */
  peekApprovalDecisions(runId: string): Promise<ApprovalDecisionItem[]>;
  /** Marks decisions as recorded. Idempotent. Call it only after the `approval_decided` events exist. */
  ackApprovalDecisions(runId: string, approvalIds: readonly string[]): Promise<void>;
  /** Renews the worker's lease on the run; throws `LeaseLostError` if it is no longer held. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a store with no outside control returns nothing
  heartbeat(runId: string): Promise<RunControl | undefined | void>;
}
