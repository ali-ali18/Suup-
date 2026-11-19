import { type PlanStep, type RunEventData, runEventSchema } from "../events.js";
import {
  type ApprovalDecisionItem,
  type InboxItem,
  type InboxItemInput,
  LeaseLostError,
  type RunControl,
  type RunOrigin,
  type RunRecord,
  type RunResult,
  type RunStatus,
  type RunStore,
  type StatusChange,
  type StoredEvent,
  type UsageDelta,
} from "../loop/store.js";

export interface CreateRunInput {
  id?: string;
  botId?: string;
  objective: string;
  acceptanceCriteria?: string[];
  status?: RunStatus;
  origin?: RunOrigin;
}

export interface InMemoryRunStoreOptions {
  /** Time source for `createdAt` and `startedAt`. Default: the real clock. */
  clock?: () => Date;
}

interface Entry {
  record: RunRecord;
  events: StoredEvent[];
  inbox: { item: InboxItem; acked: boolean }[];
  /** Decisions made from outside, until the loop records them in the log. */
  approvals: { item: ApprovalDecisionItem; acked: boolean }[];
  failure?: { origin: string; detail: string };
  result?: RunResult;
  /** While the run is `waiting_timer`: when it wakes, the note and the count (as the columns). */
  wake: { at: string; note: string; count: number } | null;
  heartbeats: number;
  /** What the user asked of the run from outside (see `setControl`). */
  control: RunControl;
  /** Who holds the run and when the lease was last renewed (epoch ms of the store's clock). */
  lease: { workerId: string; at: number } | null;
}

/**
 * In-memory `RunStore` for tests. Events are validated against the real event schema, so a test
 * run cannot log something the database adapter would reject.
 */
export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, Entry>();
  readonly #clock: () => Date;
  #nextId = 1;
  #nextInboxId = 1;

  constructor(options: InMemoryRunStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Creates a run. It starts `running` unless `status` says otherwise. */
  createRun(input: CreateRunInput): RunRecord {
    const id = input.id ?? `run-${this.#nextId++}`;
    if (this.#runs.has(id)) throw new Error(`run "${id}" already exists`);
    const now = this.#clock();
    const record: RunRecord = {
      id,
      botId: input.botId ?? "bot-1",
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      plan: [],
      status: input.status ?? "running",
      origin: input.origin ?? "user",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      createdAt: now,
      startedAt: now,
    };
    this.#runs.set(id, {
      record,
      events: [],
      inbox: [],
      approvals: [],
      wake: null,
      heartbeats: 0,
      control: { pause: false, interrupt: false },
      lease: null,
    });
    return structuredClone(record);
  }

  /** Posts something to the run from outside, as the server would. Returns the item's id. */
  postInbox(runId: string, item: InboxItemInput): string {
    const entry = this.#entry(runId);
    const id = String(this.#nextInboxId++);
    entry.inbox.push({ item: { ...structuredClone(item), id }, acked: false });
    // Same as the database store: an item posted to a run that waits for the user makes it
    // claimable again.
    if (entry.record.status === "waiting_user" || entry.record.status === "waiting_timer") {
      this.#requeue(entry);
    }
    return id;
  }

  /** When the parked run wakes, as the database columns would say; `null` unless it is parked. */
  wakeOf(runId: string): { at: string; note: string; count: number } | null {
    const entry = this.#entry(runId);
    return entry.wake === null ? null : { ...entry.wake };
  }

  /**
   * Plays the job that wakes runs: every `waiting_timer` run whose instant is `now` or earlier
   * gets its `wait_fired` event and becomes claimable, in one step. Returns the ids it woke. Safe
   * to call again: a run that was woken is not parked any more.
   */
  wakeDue(now: Date = this.#clock()): string[] {
    const woken: string[] = [];
    for (const [id, entry] of this.#runs) {
      if (entry.record.status !== "waiting_timer" || entry.wake === null) continue;
      const due = new Date(entry.wake.at).getTime();
      if (due > now.getTime()) continue;
      const seq = entry.events.length + 1;
      entry.events.push({
        ...runEventSchema.parse({
          type: "wait_fired",
          payload: {
            at: entry.wake.at,
            note: entry.wake.note,
            delayMs: Math.max(0, now.getTime() - due),
          },
        }),
        seq,
        createdAt: now,
      });
      entry.wake = null;
      this.#requeue(entry);
      woken.push(id);
    }
    return woken;
  }

  /**
   * Plays the user answering an approval card: the decision is held until the loop records it,
   * and a run waiting for it becomes claimable again, as in the database. The approval id is the
   * one in the `approval_requested` event. Returns the id of the call it concerns.
   */
  decideApproval(
    runId: string,
    approvalId: string,
    decision: Omit<ApprovalDecisionItem, "approvalId" | "callId">,
  ): string {
    const entry = this.#entry(runId);
    const requested = entry.events.find(
      (e) => e.type === "approval_requested" && e.payload.approvalId === approvalId,
    );
    if (requested === undefined || requested.type !== "approval_requested") {
      throw new Error(`run "${runId}" has no approval "${approvalId}"`);
    }
    entry.approvals.push({
      item: { ...decision, approvalId, callId: requested.payload.callId },
      acked: false,
    });
    if (entry.record.status === "waiting_approval") this.#requeue(entry);
    return requested.payload.callId;
  }

  /**
   * Plays the server pausing or interrupting the run: the flags come back from the next
   * `heartbeat`, a paused run is not handed out by `claimNext`, and a claim clears an interrupt
   * (the database does the same).
   */
  setControl(runId: string, control: Partial<RunControl>): void {
    Object.assign(this.#entry(runId).control, control);
  }

  /** Every item ever posted to the run, with whether it was acknowledged. For test assertions. */
  inboxLog(runId: string): { id: string; kind: InboxItem["kind"]; acked: boolean }[] {
    return this.#entry(runId).inbox.map((e) => ({
      id: e.item.id,
      kind: e.item.kind,
      acked: e.acked,
    }));
  }

  /** How many times the loop renewed its lease. */
  heartbeats(runId: string): number {
    return this.#entry(runId).heartbeats;
  }

  /** The failure and result stored with the run's last status change. */
  outcome(runId: string): { failure?: { origin: string; detail: string }; result?: RunResult } {
    const entry = this.#entry(runId);
    return {
      ...(entry.failure === undefined ? {} : { failure: { ...entry.failure } }),
      ...(entry.result === undefined ? {} : { result: structuredClone(entry.result) }),
    };
  }

  async getRun(runId: string): Promise<RunRecord> {
    return structuredClone(this.#entry(runId).record);
  }

  async appendEvent(runId: string, event: RunEventData): Promise<{ seq: number }> {
    const entry = this.#entry(runId);
    const parsed = runEventSchema.parse(structuredClone(event));
    const seq = entry.events.length + 1;
    entry.events.push({ ...parsed, seq, createdAt: this.#clock() });
    return { seq };
  }

  async listEvents(runId: string): Promise<StoredEvent[]> {
    return structuredClone(this.#entry(runId).events);
  }

  async setStatus(runId: string, change: StatusChange): Promise<boolean> {
    const entry = this.#entry(runId);
    if (!change.from.includes(entry.record.status)) return false;
    entry.record.status = change.to;
    entry.wake =
      change.to === "waiting_timer" && change.wake !== undefined ? { ...change.wake } : null;
    if (change.failure === undefined) delete entry.failure;
    else entry.failure = { ...change.failure };
    if (change.result === undefined) delete entry.result;
    else entry.result = structuredClone(change.result);
    if (change.to === "done" || change.to === "failed" || change.to === "cancelled") {
      entry.lease = null;
    }
    if (
      change.requeueIfInbox === true &&
      (change.to === "waiting_user" || change.to === "waiting_timer") &&
      entry.inbox.some((e) => !e.acked)
    ) {
      this.#requeue(entry);
    }
    if (
      change.requeueIfDecided === true &&
      change.to === "waiting_approval" &&
      entry.approvals.some((e) => !e.acked)
    ) {
      this.#requeue(entry);
    }
    return true;
  }

  async updatePlan(runId: string, plan: PlanStep[]): Promise<void> {
    this.#entry(runId).record.plan = structuredClone(plan);
  }

  async addUsage(runId: string, usage: UsageDelta): Promise<void> {
    const { record } = this.#entry(runId);
    record.turns += usage.turns ?? 0;
    record.inputTokens += usage.inputTokens ?? 0;
    record.outputTokens += usage.outputTokens ?? 0;
    record.costUsd += usage.costUsd ?? 0;
  }

  async peekInbox(runId: string): Promise<InboxItem[]> {
    return this.#entry(runId)
      .inbox.filter((e) => !e.acked)
      .map((e) => structuredClone(e.item));
  }

  async ackInbox(runId: string, ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    for (const e of this.#entry(runId).inbox) if (wanted.has(e.item.id)) e.acked = true;
  }

  async peekApprovalDecisions(runId: string): Promise<ApprovalDecisionItem[]> {
    return this.#entry(runId)
      .approvals.filter((e) => !e.acked)
      .map((e) => structuredClone(e.item));
  }

  async ackApprovalDecisions(runId: string, ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids);
    for (const e of this.#entry(runId).approvals) if (wanted.has(e.item.approvalId)) e.acked = true;
  }

  async heartbeat(runId: string): Promise<RunControl> {
    const entry = this.#entry(runId);
    entry.heartbeats += 1;
    return { ...entry.control };
  }

  #requeue(entry: Entry): void {
    entry.wake = null;
    entry.record.status = "queued";
    entry.lease = null;
    entry.control.interrupt = false;
  }

  // --- the queue, as the database has it (`runs` with `FOR UPDATE SKIP LOCKED`) ----------------

  /** Takes the oldest queued run for `workerId`: status `running`, lease set. */
  claimNext(workerId: string): RunRecord | null {
    let oldest: Entry | undefined;
    for (const entry of this.#runs.values()) {
      if (entry.record.status !== "queued" || entry.control.pause) continue;
      if (oldest === undefined || entry.record.createdAt < oldest.record.createdAt) oldest = entry;
    }
    if (oldest === undefined) return null;
    oldest.record.status = "running";
    oldest.control.interrupt = false;
    oldest.lease = { workerId, at: this.#clock().getTime() };
    return structuredClone(oldest.record);
  }

  /** Gives a run the worker holds back to the queue. False if the worker does not hold it. */
  releaseLease(runId: string, workerId: string): boolean {
    const entry = this.#entry(runId);
    if (entry.lease?.workerId !== workerId || entry.record.status !== "running") return false;
    this.#requeue(entry);
    return true;
  }

  /** Running runs whose lease was last renewed more than `olderThanMs` ago go back to the queue. */
  requeueStale(olderThanMs: number): string[] {
    const cutoff = this.#clock().getTime() - olderThanMs;
    const out: string[] = [];
    for (const [id, entry] of this.#runs) {
      if (entry.record.status === "running" && entry.lease !== null && entry.lease.at < cutoff) {
        this.#requeue(entry);
        out.push(id);
      }
    }
    return out;
  }

  /** Hands the lease on the run to `workerId`, as if it had claimed it. */
  assignLease(runId: string, workerId: string): void {
    this.#entry(runId).lease = { workerId, at: this.#clock().getTime() };
  }

  /** The worker holding the run, if any. */
  leaseHolder(runId: string): string | null {
    return this.#entry(runId).lease?.workerId ?? null;
  }

  /**
   * The store as one worker sees it, fenced like the database store: every write, and
   * `heartbeat`, throws `LeaseLostError` unless the run is leased to that worker.
   */
  forWorker(workerId: string): RunStore {
    const check = (runId: string): Entry => {
      const entry = this.#entry(runId);
      if (entry.lease?.workerId !== workerId) throw new LeaseLostError(runId);
      return entry;
    };
    return {
      getRun: (runId) => this.getRun(runId),
      listEvents: (runId) => this.listEvents(runId),
      peekInbox: (runId) => this.peekInbox(runId),
      appendEvent: async (runId, event) => {
        check(runId);
        return this.appendEvent(runId, event);
      },
      setStatus: async (runId, change) => {
        check(runId);
        return this.setStatus(runId, change);
      },
      updatePlan: async (runId, plan) => {
        check(runId);
        return this.updatePlan(runId, plan);
      },
      addUsage: async (runId, usage) => {
        check(runId);
        return this.addUsage(runId, usage);
      },
      ackInbox: async (runId, ids) => {
        check(runId);
        return this.ackInbox(runId, ids);
      },
      peekApprovalDecisions: (runId) => this.peekApprovalDecisions(runId),
      ackApprovalDecisions: async (runId, ids) => {
        check(runId);
        return this.ackApprovalDecisions(runId, ids);
      },
      heartbeat: async (runId) => {
        const entry = check(runId);
        entry.lease = { workerId, at: this.#clock().getTime() };
        entry.heartbeats += 1;
        return { ...entry.control };
      },
    };
  }

  #entry(runId: string): Entry {
    const entry = this.#runs.get(runId);
    if (entry === undefined) throw new Error(`unknown run "${runId}"`);
    return entry;
  }
}
