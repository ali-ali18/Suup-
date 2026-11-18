import { type PlanStep, type RunEventData, runEventSchema } from "../events.js";
import type {
  InboxItem,
  RunOrigin,
  RunRecord,
  RunResult,
  RunStatus,
  RunStore,
  StatusChange,
  StoredEvent,
  UsageDelta,
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
  inbox: InboxItem[];
  failure?: { origin: string; detail: string };
  result?: RunResult;
  heartbeats: number;
}

/**
 * In-memory `RunStore` for tests. Events are validated against the real event schema, so a test
 * run cannot log something the database adapter would reject.
 */
export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, Entry>();
  readonly #clock: () => Date;
  #nextId = 1;

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
    this.#runs.set(id, { record, events: [], inbox: [], heartbeats: 0 });
    return structuredClone(record);
  }

  /** Posts something to the run from outside, as the server would. */
  postInbox(runId: string, item: InboxItem): void {
    this.#entry(runId).inbox.push(structuredClone(item));
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

  async drainInbox(runId: string): Promise<InboxItem[]> {
    const entry = this.#entry(runId);
    return entry.inbox.splice(0, entry.inbox.length);
  }

  async heartbeat(runId: string): Promise<void> {
    this.#entry(runId).heartbeats += 1;
  }

  #entry(runId: string): Entry {
    const entry = this.#runs.get(runId);
    if (entry === undefined) throw new Error(`unknown run "${runId}"`);
    return entry;
  }
}
