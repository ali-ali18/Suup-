import { type PlanStep, type RunEventData, runEventSchema } from "../events.js";
import {
  type InboxItem,
  type InboxItemInput,
  LeaseLostError,
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
  failure?: { origin: string; detail: string };
  result?: RunResult;
  heartbeats: number;
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
    this.#runs.set(id, { record, events: [], inbox: [], heartbeats: 0, lease: null });
    return structuredClone(record);
  }

  /** Posts something to the run from outside, as the server would. Returns the item's id. */
  postInbox(runId: string, item: InboxItemInput): string {
    const entry = this.#entry(runId);
    const id = String(this.#nextInboxId++);
    entry.inbox.push({ item: { ...structuredClone(item), id }, acked: false });
    // Same as the database store: an item posted to a run that waits for the user makes it
    // claimable again.
    if (entry.record.status === "waiting_user") this.#requeue(entry);
    return id;
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
    if (change.failure === undefined) delete entry.failure;
    else entry.failure = { ...change.failure };
    if (change.result === undefined) delete entry.result;
    else entry.result = structuredClone(change.result);
    if (change.to === "done" || change.to === "failed" || change.to === "cancelled") {
      entry.lease = null;
    }
    if (
      change.requeueIfInbox === true &&
      change.to === "waiting_user" &&
      entry.inbox.some((e) => !e.acked)
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

  async heartbeat(runId: string): Promise<void> {
    this.#entry(runId).heartbeats += 1;
  }

  #requeue(entry: Entry): void {
    entry.record.status = "queued";
    entry.lease = null;
  }

  // --- the queue, as the database has it (`runs` with `FOR UPDATE SKIP LOCKED`) ----------------

  /** Takes the oldest queued run for `workerId`: status `running`, lease set. */
  claimNext(workerId: string): RunRecord | null {
    let oldest: Entry | undefined;
    for (const entry of this.#runs.values()) {
      if (entry.record.status !== "queued") continue;
      if (oldest === undefined || entry.record.createdAt < oldest.record.createdAt) oldest = entry;
    }
    if (oldest === undefined) return null;
    oldest.record.status = "running";
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
      heartbeat: async (runId) => {
        const entry = check(runId);
        entry.lease = { workerId, at: this.#clock().getTime() };
        entry.heartbeats += 1;
      },
    };
  }

  #entry(runId: string): Entry {
    const entry = this.#runs.get(runId);
    if (entry === undefined) throw new Error(`unknown run "${runId}"`);
    return entry;
  }
}
