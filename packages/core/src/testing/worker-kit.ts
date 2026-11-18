import {
  type GenerateRequest,
  type Provider,
  ProviderError,
  type ProviderEvent,
} from "../provider.js";
import type { RunQueue, WorkerClock } from "../worker.js";
import type { InMemoryRunStore } from "./memory-store.js";

interface Timer {
  seq: number;
  at: number;
  fire(): void;
  every?: number;
}

/**
 * A clock that only moves when told to: `advance(ms)` fires the timers that fall due, in order,
 * letting the promise chains they unleash run before the next one. It never touches real time.
 */
export class FakeClock implements WorkerClock {
  #now: number;
  #seq = 0;
  readonly #timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer: Timer = {
        seq: this.#seq++,
        at: this.#now + ms,
        fire: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.#remove(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#timers.push(timer);
    });
  }

  every(ms: number, fn: () => void): { stop(): void } {
    const timer: Timer = { seq: this.#seq++, at: this.#now + ms, every: ms, fire: fn };
    this.#timers.push(timer);
    return { stop: () => this.#remove(timer) };
  }

  /** Timers waiting to fire. */
  get pending(): number {
    return this.#timers.length;
  }

  /** Moves time forward by `ms`, firing everything that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await this.flush();
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.#now = due.at;
      if (due.every === undefined) this.#remove(due);
      else due.at += due.every;
      due.fire();
      await this.flush();
    }
    this.#now = target;
    await this.flush();
  }

  /** Lets pending promise chains run (everything in the tests is microtask-driven). */
  async flush(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  #remove(timer: Timer): void {
    const i = this.#timers.indexOf(timer);
    if (i !== -1) this.#timers.splice(i, 1);
  }
}

/**
 * `RunQueue` over an `InMemoryRunStore`, with the same rules as the database queue: a claim takes
 * the oldest queued run and leases it, release and fail only act for the worker holding the lease.
 */
export class InMemoryRunQueue implements RunQueue {
  readonly #store: InMemoryRunStore;
  readonly #claimedBy = new Map<string, string>();

  constructor(store: InMemoryRunStore) {
    this.#store = store;
  }

  async claimNext(workerId: string): Promise<{ runId: string } | null> {
    const run = this.#store.claimNext(workerId);
    if (run === null) return null;
    this.#claimedBy.set(run.id, workerId);
    return { runId: run.id };
  }

  async release(runId: string): Promise<void> {
    const workerId = this.#claimedBy.get(runId);
    if (workerId !== undefined) this.#store.releaseLease(runId, workerId);
  }

  async requeueStale(olderThanMs: number): Promise<number> {
    return this.#store.requeueStale(olderThanMs).length;
  }

  async fail(runId: string, failure: Parameters<RunQueue["fail"]>[1]): Promise<void> {
    const workerId = this.#claimedBy.get(runId);
    if (workerId === undefined || this.#store.leaseHolder(runId) !== workerId) return;
    const { status } = await this.#store.getRun(runId);
    await this.#store.appendEvent(runId, {
      type: "status_changed",
      payload: { from: status, to: "failed", failure },
    });
    await this.#store.setStatus(runId, { from: [status], to: "failed", failure });
  }
}

/**
 * A provider that hangs on its call number `hangAt` (0-based) until the request is aborted, then
 * fails that call with `aborted`, like a real adapter does; every other call goes to `inner`.
 * It stands for "a long model call" in worker tests.
 */
export function hangingAt(inner: Provider, hangAt: number): Provider {
  let calls = 0;
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    generate(req: GenerateRequest): AsyncIterable<ProviderEvent> {
      if (calls++ !== hangAt) return inner.generate(req);
      return (async function* () {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new ProviderError("aborted", "request aborted"));
          if (req.signal?.aborted) abort();
          req.signal?.addEventListener("abort", abort, { once: true });
        });
      })();
    },
  };
}
