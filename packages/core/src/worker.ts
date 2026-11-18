import type { FailureOrigin, RunStatus } from "./events.js";
import { type LoopDeps, runLoop } from "./loop/loop.js";
import { LeaseLostError } from "./loop/store.js";

/**
 * What the worker needs from the queue of runs. The database implements it with `SKIP LOCKED`
 * (`PgRunQueue` in `@suup/db`); tests use an in-memory one.
 *
 * Every method that concerns a run the worker claimed acts on behalf of the worker that claimed
 * it: if the run is no longer leased to that worker (it was requeued and taken over), the call
 * must do nothing, quietly.
 */
export interface RunQueue {
  /** Takes the oldest queued run for `workerId` (status `running`, leased), or `null`. */
  claimNext(workerId: string): Promise<{ runId: string } | null>;
  /** Gives a claimed run back (`queued`, lease cleared) so another worker can resume it. */
  release(runId: string): Promise<void>;
  /**
   * Puts runs that are `running` but whose lease was last renewed more than `olderThanMs` ago
   * back in the queue. Returns how many. Runs waiting for a person are never touched.
   */
  requeueStale(olderThanMs: number): Promise<number>;
  /**
   * Ends a claimed run as `failed`, logging the status change like the loop does. The worker uses
   * it when something outside the model/tool path broke (building the dependencies, a bug in the
   * loop), where the run's own store may not be usable.
   */
  fail(runId: string, failure: { origin: FailureOrigin; detail: string }): Promise<void>;
}

/** The worker's view of time. The default is the real clock; tests inject a fake one. */
export interface WorkerClock {
  now(): number;
  /** Resolves after `ms`, or early (without error) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Calls `fn` every `ms` until stopped. */
  every(ms: number, fn: () => void): { stop(): void };
}

export const systemClock: WorkerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return { stop: () => clearInterval(timer) };
  },
};

/** How a run left the worker. */
export type RunEnd =
  | {
      runId: string;
      /** The loop returned a status other than `running`: finished, or waiting for a person. */
      outcome: "settled";
      status: RunStatus;
      durationMs: number;
    }
  | {
      runId: string;
      /** The loop was interrupted (the worker is stopping) and the run went back to the queue. */
      outcome: "released";
    }
  | {
      runId: string;
      /** Something threw outside the model/tool path: the run was marked `failed` (harness). */
      outcome: "failed";
      error: unknown;
    }
  | {
      runId: string;
      /** The lease is gone: another worker owns the run now. Nothing more was written. */
      outcome: "lease_lost";
    };

export interface WorkerOptions {
  workerId: string;
  queue: RunQueue;
  /**
   * Everything the loop needs for one run: store (bound to this worker, so it fences writes),
   * provider, tools, executor, bot. Called once per claimed run. If it throws, the run is failed.
   */
  buildDeps(runId: string): Promise<LoopDeps>;
  /** Runs at the same time. Default 4. */
  concurrency?: number;
  /** How often the lease of each running run is renewed, independently of the loop. Default 10s. */
  leaseRenewMs?: number;
  /** A lease not renewed for this long is stale. Must exceed `leaseRenewMs`. Default 3x it. */
  staleAfterMs?: number;
  /** How often to look for stale runs. Default 30s. */
  requeueEveryMs?: number;
  /** Wait between polls of an empty queue: starts at `minMs`, multiplied by `factor` up to `maxMs`. */
  idleBackoff?: { minMs?: number; maxMs?: number; factor?: number };
  clock?: WorkerClock;
  /** A run left the worker. Errors thrown by the hook are ignored. */
  onRunEnd?(end: RunEnd): void;
  /** Something went wrong in the background (a failed claim, a failed heartbeat...). */
  onError?(error: unknown, context: string): void;
}

interface ActiveRun {
  runId: string;
  abort: AbortController;
  /** The lease is gone (or the run was claimed again by this worker): drop it silently. */
  lost: boolean;
  done: Promise<void>;
}

/**
 * Runs queued runs: polls the queue, runs the loop for up to `concurrency` runs at once, keeps
 * their leases alive while the loop sits in a long model or tool call, requeues the runs of dead
 * workers, and shuts down cleanly. See section 4.15 of the plan.
 *
 * Nothing a run does takes the worker down: a loop that throws marks its run `failed` with origin
 * `harness`; a `LeaseLostError` just drops the run (someone else has it).
 */
export class Worker {
  readonly workerId: string;
  readonly #queue: RunQueue;
  readonly #buildDeps: (runId: string) => Promise<LoopDeps>;
  readonly #concurrency: number;
  readonly #leaseRenewMs: number;
  readonly #staleAfterMs: number;
  readonly #requeueEveryMs: number;
  readonly #idle: { minMs: number; maxMs: number; factor: number };
  readonly #clock: WorkerClock;
  readonly #onRunEnd: ((end: RunEnd) => void) | undefined;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  readonly #active = new Map<string, ActiveRun>();
  readonly #stopSignal = new AbortController();
  readonly #slotWaiters: (() => void)[] = [];
  #polling: Promise<void> | undefined;
  #requeueTimer: { stop(): void } | undefined;
  #requeueing: Promise<void> | undefined;
  #stopping = false;
  #stopped: Promise<void> | undefined;

  constructor(options: WorkerOptions) {
    this.workerId = options.workerId;
    this.#queue = options.queue;
    this.#buildDeps = options.buildDeps;
    this.#concurrency = options.concurrency ?? 4;
    this.#leaseRenewMs = options.leaseRenewMs ?? 10_000;
    this.#staleAfterMs = options.staleAfterMs ?? this.#leaseRenewMs * 3;
    this.#requeueEveryMs = options.requeueEveryMs ?? 30_000;
    this.#idle = {
      minMs: options.idleBackoff?.minMs ?? 250,
      maxMs: options.idleBackoff?.maxMs ?? 5_000,
      factor: options.idleBackoff?.factor ?? 2,
    };
    this.#clock = options.clock ?? systemClock;
    this.#onRunEnd = options.onRunEnd;
    this.#onError = options.onError;

    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new RangeError("Worker: concurrency must be an integer of at least 1");
    }
    if (!(this.#leaseRenewMs > 0)) throw new RangeError("Worker: leaseRenewMs must be positive");
    if (!(this.#staleAfterMs > this.#leaseRenewMs)) {
      throw new RangeError("Worker: staleAfterMs must be greater than leaseRenewMs");
    }
    if (!(this.#idle.minMs > 0 && this.#idle.maxMs >= this.#idle.minMs && this.#idle.factor >= 1)) {
      throw new RangeError("Worker: invalid idleBackoff");
    }
  }

  /** The runs being worked on right now. */
  get activeRunIds(): string[] {
    return [...this.#active.keys()];
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /** Starts polling. Returns at once; the work happens in the background. */
  start(): void {
    if (this.#polling !== undefined) throw new Error("Worker: already started");
    if (this.#stopping) throw new Error("Worker: already stopped");
    this.#polling = this.#poll();
    this.#requeueTimer = this.#clock.every(this.#requeueEveryMs, () => void this.#requeueStale());
    void this.#requeueStale();
  }

  /**
   * Shuts down: stops claiming, lets the runs in progress carry on for up to `graceMs` (they may
   * finish or reach a wait by themselves), then interrupts the rest (each stops at its safe point
   * and is given back to the queue), and resolves when every run has left the worker. Calling it
   * again returns the same promise.
   */
  stop(options: { graceMs?: number } = {}): Promise<void> {
    this.#stopped ??= this.#doStop(Math.max(0, options.graceMs ?? 0));
    return this.#stopped;
  }

  // --- polling ---------------------------------------------------------------------------

  async #poll(): Promise<void> {
    let idleMs = this.#idle.minMs;
    const backOff = () => Math.min(this.#idle.maxMs, idleMs * this.#idle.factor);
    while (!this.#stopping) {
      if (this.#active.size >= this.#concurrency) {
        await this.#waitForSlot();
        continue;
      }
      let claimed: { runId: string } | null;
      try {
        claimed = await this.#queue.claimNext(this.workerId);
      } catch (error) {
        this.#report(error, "claiming the next run");
        await this.#clock.sleep(idleMs, this.#stopSignal.signal);
        idleMs = backOff();
        continue;
      }
      if (claimed === null) {
        await this.#clock.sleep(idleMs, this.#stopSignal.signal);
        idleMs = backOff();
        continue;
      }
      idleMs = this.#idle.minMs;
      if (this.#stopping) {
        // Claimed while shutting down: not started, so give it straight back.
        await this.#giveBack(claimed.runId);
        break;
      }
      await this.#launch(claimed.runId);
    }
  }

  #waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => this.#slotWaiters.push(resolve));
  }

  #wakeSlotWaiters(): void {
    for (const wake of this.#slotWaiters.splice(0)) wake();
  }

  async #launch(runId: string): Promise<void> {
    const previous = this.#active.get(runId);
    if (previous !== undefined) {
      // The run was requeued as stale and claimed again by this very worker while the old loop
      // was still going. The old loop is a zombie: stop it before the new one starts.
      previous.lost = true;
      previous.abort.abort();
      await previous.done;
      if (this.#stopping) return this.#giveBack(runId);
    }
    const entry: ActiveRun = {
      runId,
      abort: new AbortController(),
      lost: false,
      done: Promise.resolve(),
    };
    entry.done = this.#execute(entry).finally(() => {
      if (this.#active.get(runId) === entry) this.#active.delete(runId);
      this.#wakeSlotWaiters();
    });
    this.#active.set(runId, entry);
  }

  // --- one run -----------------------------------------------------------------------------

  /** Never rejects. */
  async #execute(entry: ActiveRun): Promise<void> {
    const { runId } = entry;
    const startedAt = this.#clock.now();
    let deps: LoopDeps;
    try {
      deps = await this.#buildDeps(runId);
    } catch (error) {
      return this.#finishFailed(entry, error);
    }

    let finished = false;
    let beating = false;
    const beat = () => {
      if (finished || entry.lost || beating) return;
      beating = true;
      deps.store
        .heartbeat(runId)
        .catch((error: unknown) => {
          if (finished) return;
          if (error instanceof LeaseLostError) {
            // Someone else owns the run: stop the loop at once (it writes nothing more).
            entry.lost = true;
            entry.abort.abort();
          } else {
            // A hiccup: keep trying. If it lasts, the lease goes stale and the run is requeued.
            this.#report(error, `renewing the lease of run ${runId}`);
          }
        })
        .finally(() => {
          beating = false;
        });
    };
    const timer = this.#clock.every(this.#leaseRenewMs, beat);

    let status: RunStatus;
    try {
      status = await runLoop(deps, runId, { signal: entry.abort.signal });
    } catch (error) {
      finished = true;
      timer.stop();
      if (error instanceof LeaseLostError || entry.lost)
        return this.#emit({ runId, outcome: "lease_lost" });
      return this.#finishFailed(entry, error);
    }
    finished = true;
    timer.stop();

    if (entry.lost) return this.#emit({ runId, outcome: "lease_lost" });
    if (status === "running") {
      // Interrupted at a safe point: back to the queue, to be resumed from the log.
      await this.#giveBack(runId);
      return this.#emit({ runId, outcome: "released" });
    }
    this.#emit({
      runId,
      outcome: "settled",
      status,
      durationMs: Math.max(0, this.#clock.now() - startedAt),
    });
  }

  async #finishFailed(entry: ActiveRun, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await this.#queue.fail(entry.runId, { origin: "harness", detail });
    } catch (failure) {
      // The run stays as it is; the lease goes stale and another worker retries it.
      this.#report(failure, `marking run ${entry.runId} as failed`);
    }
    this.#emit({ runId: entry.runId, outcome: "failed", error });
  }

  async #giveBack(runId: string): Promise<void> {
    try {
      await this.#queue.release(runId);
    } catch (error) {
      this.#report(error, `releasing run ${runId}`);
    }
  }

  // --- stale runs --------------------------------------------------------------------------

  #requeueStale(): Promise<void> {
    if (this.#requeueing !== undefined) return this.#requeueing;
    this.#requeueing = (async () => {
      try {
        await this.#queue.requeueStale(this.#staleAfterMs);
      } catch (error) {
        this.#report(error, "requeueing stale runs");
      } finally {
        this.#requeueing = undefined;
      }
    })();
    return this.#requeueing;
  }

  // --- shutdown ----------------------------------------------------------------------------

  async #doStop(graceMs: number): Promise<void> {
    this.#stopping = true;
    this.#stopSignal.abort();
    this.#requeueTimer?.stop();
    this.#wakeSlotWaiters();
    // No new run starts from here on (a claim in flight is handed back by the poll loop).
    await this.#polling;

    if (graceMs > 0 && this.#active.size > 0) {
      const give = new AbortController();
      const allDone = Promise.all([...this.#active.values()].map((r) => r.done));
      await Promise.race([allDone, this.#clock.sleep(graceMs, give.signal)]);
      give.abort();
    }
    for (const run of this.#active.values()) run.abort.abort();
    await Promise.all([...this.#active.values()].map((r) => r.done));
    await this.#requeueing;
  }

  // --- hooks that must never throw ------------------------------------------------------------

  #emit(end: RunEnd): void {
    try {
      this.#onRunEnd?.(end);
    } catch {
      // a broken hook must not break the worker
    }
  }

  #report(error: unknown, context: string): void {
    try {
      this.#onError?.(error, context);
    } catch {
      // idem
    }
  }
}
