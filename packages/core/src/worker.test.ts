import { describe, expect, it } from "vitest";
import type { LoopDeps } from "./loop/loop.js";
import { LeaseLostError, type RunStore } from "./loop/store.js";
import type { Provider } from "./provider.js";
import { ToolRegistry } from "./registry.js";
import {
  call,
  eventsOfType,
  FakeClock,
  FakeProvider,
  hangingAt,
  InMemoryRunQueue,
  InMemoryRunStore,
  MemoryExecutor,
  say,
  testBot,
  testTools,
  use,
} from "./testing/index.js";
import { type RunEnd, type RunQueue, Worker } from "./worker.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface World {
  clock: FakeClock;
  store: InMemoryRunStore;
  queue: RunQueue;
  ends: RunEnd[];
  /** Runs the worker gave back to the queue. */
  queueReleases: string[];
  errors: { error: unknown; context: string }[];
  /** Providers by run id; a run without one gets a script that finishes at once. */
  providers: Map<string, Provider>;
  newRun(provider?: Provider, objective?: string): string;
  worker(
    id: string,
    options?: Partial<ConstructorParameters<typeof Worker>[0]>,
    wrapStore?: (store: RunStore) => RunStore,
  ): Worker;
}

function makeWorld(): World {
  const clock = new FakeClock();
  const store = new InMemoryRunStore({ clock: () => new Date(clock.now()) });
  const memoryQueue = new InMemoryRunQueue(store);
  const queueReleases: string[] = [];
  const queue: RunQueue = {
    claimNext: (id) => memoryQueue.claimNext(id),
    release: async (id) => {
      queueReleases.push(id);
      return memoryQueue.release(id);
    },
    requeueStale: (ms) => memoryQueue.requeueStale(ms),
    fail: (id, f) => memoryQueue.fail(id, f),
  };
  const registry = new ToolRegistry();
  for (const tool of testTools()) registry.register(tool);
  const executor = new MemoryExecutor();
  const providers = new Map<string, Provider>();
  const ends: RunEnd[] = [];
  const errors: { error: unknown; context: string }[] = [];
  return {
    clock,
    store,
    queue,
    ends,
    queueReleases,
    errors,
    providers,
    newRun(provider, objective = "Do the task.") {
      const run = store.createRun({ objective, status: "queued" });
      providers.set(run.id, provider ?? new FakeProvider([say("Done.")]));
      return run.id;
    },
    worker(id, options = {}, wrapStore = (s) => s) {
      return new Worker({
        workerId: id,
        queue,
        clock,
        leaseRenewMs: 1000,
        staleAfterMs: 3000,
        requeueEveryMs: 1000,
        idleBackoff: { minMs: 250, maxMs: 2000, factor: 2 },
        onRunEnd: (end) => ends.push(end),
        onError: (error, context) => errors.push({ error, context }),
        buildDeps: async (runId): Promise<LoopDeps> => {
          const provider = providers.get(runId);
          if (provider === undefined) throw new Error(`no provider for ${runId}`);
          return {
            store: wrapStore(store.forWorker(id)),
            provider,
            tools: registry,
            executor,
            bot: testBot(),
            now: () => new Date(clock.now()),
            sleep: async () => {},
          };
        },
        ...options,
      });
    },
  };
}

const statusOf = async (w: World, runId: string) => (await w.store.getRun(runId)).status;

describe("Worker: polling and concurrency", () => {
  it("runs a queued run to the end and reports it", async () => {
    const w = makeWorld();
    const runId = w.newRun();
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("done");
    expect(w.ends).toEqual([
      expect.objectContaining({ runId, outcome: "settled", status: "done" }),
    ]);
    await worker.stop();
  });

  it("polls an empty queue with a growing, capped idle backoff and resets it after a claim", async () => {
    const w = makeWorld();
    const polls: number[] = [];
    const claims: number[] = [];
    const queue: RunQueue = {
      claimNext: async (id) => {
        polls.push(w.clock.now());
        const claimed = await w.queue.claimNext(id);
        if (claimed !== null) claims.push(w.clock.now());
        return claimed;
      },
      release: (id) => w.queue.release(id),
      requeueStale: (ms) => w.queue.requeueStale(ms),
      fail: (id, f) => w.queue.fail(id, f),
    };
    const start = w.clock.now();
    const worker = w.worker("w1", { queue });
    worker.start();
    await w.clock.flush();
    await w.clock.advance(10_000);
    // 250, 500, 1000, 2000 (cap), 2000, ...
    expect(polls.slice(0, 6).map((t) => t - start)).toEqual([0, 250, 750, 1750, 3750, 5750]);

    const runId = w.newRun();
    await w.clock.advance(2000);
    expect(await statusOf(w, runId)).toBe("done");
    // Reset: the poll after the claim comes one minimum wait later.
    // After a claim the worker polls again at once (a slot may be free), finds nothing, and waits
    // the minimum again, not the grown backoff from before.
    const claimedAt = claims[0] as number;
    const at = polls.indexOf(claimedAt);
    expect(polls.slice(at, at + 3)).toEqual([claimedAt, claimedAt, claimedAt + 250]);
    await worker.stop();
  });

  it("never runs more than `concurrency` runs at once, and starts the next as slots free up", async () => {
    const w = makeWorld();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let running = 0;
    let peak = 0;
    const ids = Array.from({ length: 5 }, () => {
      const gate = deferred();
      const id = w.newRun(
        new FakeProvider([
          async () => {
            running++;
            peak = Math.max(peak, running);
            await gate.promise;
            running--;
            return say("Done.");
          },
        ]),
      );
      gates.set(id, gate);
      return id;
    });
    const worker = w.worker("w1", { concurrency: 2 });
    worker.start();
    await w.clock.flush();
    expect(worker.activeRunIds).toEqual([ids[0], ids[1]]);
    expect(await statusOf(w, ids[2] as string)).toBe("queued");

    gates.get(ids[0] as string)?.resolve();
    await w.clock.flush();
    expect(worker.activeRunIds).toEqual([ids[1], ids[2]]);

    for (const gate of gates.values()) gate.resolve();
    await w.clock.flush();
    await w.clock.advance(500);
    for (const id of ids) expect(await statusOf(w, id)).toBe("done");
    expect(peak).toBe(2);
    await worker.stop();
  });

  it("survives a failing queue and keeps polling", async () => {
    const w = makeWorld();
    let failures = 2;
    const queue: RunQueue = {
      claimNext: async (id) => {
        if (failures-- > 0) throw new Error("database is down");
        return w.queue.claimNext(id);
      },
      release: (id) => w.queue.release(id),
      requeueStale: (ms) => w.queue.requeueStale(ms),
      fail: (id, f) => w.queue.fail(id, f),
    };
    const runId = w.newRun();
    const worker = w.worker("w1", { queue });
    worker.start();
    await w.clock.flush();
    await w.clock.advance(1000);
    expect(w.errors.map((e) => e.context)).toEqual([
      "claiming the next run",
      "claiming the next run",
    ]);
    expect(await statusOf(w, runId)).toBe("done");
    await worker.stop();
  });
});

describe("Worker: leases", () => {
  it("renews the lease on a timer while the loop sits in a long model call", async () => {
    const w = makeWorld();
    const gate = deferred();
    const runId = w.newRun(
      new FakeProvider([
        async () => {
          await gate.promise;
          return say("Done.");
        },
      ]),
    );
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    const before = w.store.heartbeats(runId);
    await w.clock.advance(3500);
    expect(w.store.heartbeats(runId) - before).toBe(3);

    // The run is never mistaken for dead, however long the call takes.
    const other = w.worker("w2");
    other.start();
    await w.clock.advance(20_000);
    expect(await statusOf(w, runId)).toBe("running");
    expect(w.store.leaseHolder(runId)).toBe("w1");
    gate.resolve();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("done");
    await Promise.all([worker.stop(), other.stop()]);
  });

  it("requeues the run of a worker that died, and another worker finishes it", async () => {
    const w = makeWorld();
    const runId = w.newRun(
      new FakeProvider([use(call("c1", "echo", { text: "x" })), say("Done.")]),
    );
    // A worker claims the run and dies: it renews nothing from here on.
    expect(await w.queue.claimNext("dead")).toEqual({ runId });
    await w.clock.advance(60_000);

    const worker = w.worker("w2");
    worker.start(); // sweeps for stale runs as it starts, then claims on its next poll
    await w.clock.advance(500);
    expect(await statusOf(w, runId)).toBe("done");
    expect(w.ends).toEqual([
      expect.objectContaining({ runId, outcome: "settled", status: "done" }),
    ]);

    // The presumed-dead worker comes back and finds it can no longer write.
    await expect(
      w.store
        .forWorker("dead")
        .appendEvent(runId, { type: "nudge", payload: { reason: "r", text: "t" } }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await worker.stop();
  });

  it("never requeues runs that wait for a person, however old their lease", async () => {
    const w = makeWorld();
    const runId = w.newRun(new FakeProvider([use(call("c1", "escalate", { question: "Which?" }))]));
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("waiting_user");
    expect(w.ends).toEqual([
      expect.objectContaining({ outcome: "settled", status: "waiting_user" }),
    ]);
    await w.clock.advance(3_600_000);
    expect(await statusOf(w, runId)).toBe("waiting_user");
    await worker.stop();
  });

  it("resumes a waiting run when the user's answer is posted", async () => {
    const w = makeWorld();
    const runId = w.newRun(
      new FakeProvider([
        use(call("c1", "escalate", { question: "Which?" })),
        say("Went with blue."),
      ]),
    );
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("waiting_user");

    w.store.postInbox(runId, { kind: "user_message", text: "Blue." });
    await w.clock.advance(1000);
    expect(await statusOf(w, runId)).toBe("done");
    const events = await w.store.listEvents(runId);
    const answer = eventsOfType(events, "tool_result").find((e) => e.payload.callId === "c1");
    expect(answer?.payload.content).toBe("Blue.");
    expect(w.store.inboxLog(runId).every((i) => i.acked)).toBe(true);
    await worker.stop();
  });

  it("cancels a running run, and a waiting one, when a stop is posted (writes stay fenced)", async () => {
    const w = makeWorld();
    const running = w.newRun(hangingAt(new FakeProvider([say("never")]), 0));
    const waiting = w.newRun(
      new FakeProvider([use(call("c1", "escalate", { question: "Which?" }))]),
    );
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, waiting)).toBe("waiting_user");

    const stopWaiting = w.store.postInbox(waiting, { kind: "stop" });
    await w.clock.advance(1000);
    expect(await statusOf(w, waiting)).toBe("cancelled");

    // A stop for the run in the middle of a model call is delivered at its next safe point:
    // the call must end first (here, the worker interrupts it by stopping, then a new one resumes).
    const stopRunning = w.store.postInbox(running, { kind: "stop" });
    await worker.stop();
    expect(await statusOf(w, running)).toBe("queued");
    const second = w.worker("w2");
    w.providers.set(running, new FakeProvider([say("never")]));
    second.start();
    await w.clock.advance(1000);
    expect(await statusOf(w, running)).toBe("cancelled");
    for (const [runId, id] of [
      [waiting, stopWaiting],
      [running, stopRunning],
    ] as const) {
      expect(w.store.inboxLog(runId)).toEqual([{ id, kind: "stop", acked: true }]);
    }
    await second.stop();
  });

  it("drops a run whose lease was lost, writing nothing more, and keeps working", async () => {
    const w = makeWorld();
    const slow = w.newRun(hangingAt(new FakeProvider([say("Late answer.")]), 0));
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();

    // Someone else takes the run over behind the worker's back.
    w.store.releaseLease(slow, "w1");
    expect(w.store.claimNext("w2")?.id).toBe(slow);
    const eventsBefore = (await w.store.listEvents(slow)).length;

    // The next lease renewal finds out.
    await w.clock.advance(1000);
    expect(w.ends).toEqual([{ runId: slow, outcome: "lease_lost" }]);
    expect(worker.activeRunIds).toEqual([]);

    // The interrupted call wrote nothing, and nothing was failed.
    await w.clock.flush();
    expect((await w.store.listEvents(slow)).length).toBe(eventsBefore);
    expect(await statusOf(w, slow)).toBe("running");
    expect(w.store.leaseHolder(slow)).toBe("w2");

    // The worker itself is fine.
    const next = w.newRun();
    await w.clock.advance(2000);
    expect(await statusOf(w, next)).toBe("done");
    await worker.stop();
  });

  it("notices a lost lease from a write when no heartbeat came first", async () => {
    const w = makeWorld();
    const gate = deferred();
    const runId = w.newRun(
      new FakeProvider([
        async () => {
          await gate.promise;
          return say("Late answer.");
        },
      ]),
    );
    const worker = w.worker("w1", { leaseRenewMs: 100_000, staleAfterMs: 300_000 });
    worker.start();
    await w.clock.flush();
    w.store.releaseLease(runId, "w1");
    w.store.claimNext("w2");
    const eventsBefore = (await w.store.listEvents(runId)).length;
    gate.resolve();
    await w.clock.flush();
    expect(w.ends).toEqual([{ runId, outcome: "lease_lost" }]);
    expect(w.errors).toEqual([]);
    expect((await w.store.listEvents(runId)).length).toBe(eventsBefore);
    expect(await statusOf(w, runId)).toBe("running");
    await worker.stop();
  });
});

describe("Worker: failures", () => {
  it("marks a run failed (harness) when its dependencies cannot be built, and goes on", async () => {
    const w = makeWorld();
    const broken = w.newRun();
    w.providers.delete(broken); // buildDeps throws "no provider for ..."
    const fine = w.newRun();
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, broken)).toBe("failed");
    expect(w.store.outcome(broken).failure).toEqual({
      origin: "harness",
      detail: `no provider for ${broken}`,
    });
    const failedEvent = eventsOfType(await w.store.listEvents(broken), "status_changed").pop();
    expect(failedEvent?.payload).toMatchObject({ to: "failed", failure: { origin: "harness" } });
    expect(await statusOf(w, fine)).toBe("done");
    expect(w.ends.map((e) => e.outcome).sort()).toEqual(["failed", "settled"]);
    await worker.stop();
  });

  it("marks a run failed (harness) with the error message when the loop itself throws", async () => {
    const w = makeWorld();
    const runId = w.newRun(new FakeProvider([say("Done.")]));
    const worker = w.worker("w1", {}, (store) => ({
      getRun: (id) => store.getRun(id),
      listEvents: (id) => store.listEvents(id),
      peekInbox: (id) => store.peekInbox(id),
      appendEvent: (id, e) => store.appendEvent(id, e),
      setStatus: (id, c) => store.setStatus(id, c),
      updatePlan: (id, p) => store.updatePlan(id, p),
      ackInbox: (id, ids) => store.ackInbox(id, ids),
      heartbeat: (id) => store.heartbeat(id),
      addUsage: async () => {
        throw new Error("disk quota exceeded");
      },
    }));
    worker.start();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("failed");
    expect(w.store.outcome(runId).failure).toEqual({
      origin: "harness",
      detail: "disk quota exceeded",
    });
    expect(w.ends).toEqual([expect.objectContaining({ runId, outcome: "failed" })]);
    expect(worker.activeRunIds).toEqual([]);
    await worker.stop();
  });

  it("a throwing hook does not take the worker down", async () => {
    const w = makeWorld();
    const first = w.newRun();
    const worker = w.worker("w1", {
      onRunEnd: () => {
        throw new Error("hook bug");
      },
      onError: () => {
        throw new Error("hook bug");
      },
    });
    worker.start();
    await w.clock.flush();
    const second = w.newRun();
    await w.clock.advance(1000);
    expect(await statusOf(w, first)).toBe("done");
    expect(await statusOf(w, second)).toBe("done");
    await worker.stop();
  });
});

describe("Worker: graceful stop", () => {
  const twoStepRun = () =>
    new FakeProvider([
      use(call("c1", "write_note", { name: "a.txt", body: "1" })),
      say("All done."),
    ]);

  it("interrupts a run mid-call, hands it back, and a second worker finishes it from the log", async () => {
    const w = makeWorld();
    // call 0 writes a file, call 1 hangs until aborted, call 2 finishes
    const inner = new FakeProvider([
      use(call("c1", "write_note", { name: "a.txt", body: "1" })),
      say("All done."),
    ]);
    const runId = w.newRun(hangingAt(inner, 1));
    const first = w.worker("w1");
    first.start();
    await w.clock.flush();
    expect(first.activeRunIds).toEqual([runId]);

    const stopped = first.stop({ graceMs: 0 });
    await w.clock.flush();
    await stopped;
    expect(w.ends).toEqual([{ runId, outcome: "released" }]);
    expect(await statusOf(w, runId)).toBe("queued");
    expect(w.store.leaseHolder(runId)).toBeNull();
    expect(first.activeRunIds).toEqual([]);

    const second = w.worker("w2");
    second.start();
    await w.clock.flush();
    expect(await statusOf(w, runId)).toBe("done");
    const events = await w.store.listEvents(runId);
    // The tool ran once, in the first life; the second life only finished the work.
    expect(
      eventsOfType(events, "tool_call").filter((e) => e.payload.name === "write_note"),
    ).toHaveLength(1);
    expect(eventsOfType(events, "tool_result").map((e) => e.payload.outcome)).toEqual(["ok"]);
    await second.stop();
  });

  it("gives running runs the grace period to finish by themselves before interrupting them", async () => {
    const w = makeWorld();
    const gate = deferred();
    const finishing = w.newRun(
      new FakeProvider([
        async () => {
          await gate.promise;
          return say("Done in time.");
        },
      ]),
    );
    const stuck = w.newRun(hangingAt(twoStepRun(), 0));
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();
    expect(worker.activeRunIds.sort()).toEqual([finishing, stuck].sort());

    let stopped = false;
    const stopping = worker.stop({ graceMs: 5000 }).then(() => {
      stopped = true;
    });
    await w.clock.advance(1000);
    expect(stopped).toBe(false);
    gate.resolve(); // finishes inside the grace period
    await w.clock.advance(1000);
    expect(await statusOf(w, finishing)).toBe("done");
    expect(stopped).toBe(false); // the other run is still going

    await w.clock.advance(3500); // grace over: the stuck run is interrupted and handed back
    await stopping;
    expect(await statusOf(w, stuck)).toBe("queued");
    expect(w.ends.map((e) => [e.runId, e.outcome])).toEqual([
      [finishing, "settled"],
      [stuck, "released"],
    ]);
  });

  it("soft stop: a run in a long turn finishes that turn (tools included) and is handed back without another model call", async () => {
    const w = makeWorld();
    const gate = deferred();
    const provider = new FakeProvider([
      async () => {
        await gate.promise;
        return use(call("c1", "write_note", { name: "a.txt", body: "1" }));
      },
      say("never asked while stopping"),
    ]);
    const runId = w.newRun(provider);
    const first = w.worker("w1");
    first.start();
    await w.clock.flush();
    expect(provider.calls).toBe(1);

    let stopped = false;
    const stopping = first.stop({ graceMs: 60_000 }).then(() => {
      stopped = true;
    });
    await w.clock.advance(1000);
    expect(stopped).toBe(false); // waiting for the safe point, not aborting
    gate.resolve();
    await w.clock.flush();
    await stopping; // long before the grace period is over
    expect(provider.calls).toBe(1);
    expect(w.ends).toEqual([{ runId, outcome: "released" }]);
    expect(await statusOf(w, runId)).toBe("queued");
    const events = await w.store.listEvents(runId);
    expect(eventsOfType(events, "tool_result").map((e) => e.payload.outcome)).toEqual(["ok"]);
    expect(eventsOfType(events, "model_error")).toEqual([]);
  });

  it("abortNow cuts the grace period short and hard-aborts what is left", async () => {
    const w = makeWorld();
    const runId = w.newRun(hangingAt(twoStepRun(), 0));
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush();

    let stopped = false;
    const stopping = worker.stop({ graceMs: 600_000 }).then(() => {
      stopped = true;
    });
    await w.clock.advance(1000);
    expect(stopped).toBe(false); // the hanging model call never reaches a safe point
    const hurried = worker.abortNow();
    await w.clock.flush();
    await Promise.all([stopping, hurried]);
    expect(w.ends).toEqual([{ runId, outcome: "released" }]);
    expect(await statusOf(w, runId)).toBe("queued");
  });

  it("stops claiming at once, and hands back a run claimed while stopping", async () => {
    const w = makeWorld();
    const claim = deferred<{ runId: string } | null>();
    const releases: string[] = [];
    const queue: RunQueue = {
      claimNext: () => claim.promise,
      release: async (id) => {
        releases.push(id);
      },
      requeueStale: async () => 0,
      fail: async () => {},
    };
    const worker = w.worker("w1", { queue });
    worker.start();
    await w.clock.flush();
    const stopping = worker.stop();
    claim.resolve({ runId: "late-run" });
    await stopping;
    expect(releases).toEqual(["late-run"]);
    expect(worker.activeRunIds).toEqual([]);
    expect(w.ends).toEqual([]);
  });

  it("stop is idempotent and works on a worker that never started", async () => {
    const w = makeWorld();
    const worker = w.worker("w1");
    await worker.stop();
    await worker.stop();
    expect(() => worker.start()).toThrow(/already stopped/);
  });

  it("validates its options", () => {
    const w = makeWorld();
    expect(() => w.worker("w1", { concurrency: 0 })).toThrow(/concurrency/);
    expect(() => w.worker("w1", { leaseRenewMs: 1000, staleAfterMs: 1000 })).toThrow(
      /staleAfterMs/,
    );
  });
});

/** A store whose `setStatus` runs `after` once the change is applied, before the loop goes on. */
function afterSetStatus(
  store: RunStore,
  after: (change: Parameters<RunStore["setStatus"]>[1]) => Promise<void> | void,
): RunStore {
  return {
    getRun: (id) => store.getRun(id),
    listEvents: (id) => store.listEvents(id),
    peekInbox: (id) => store.peekInbox(id),
    appendEvent: (id, e) => store.appendEvent(id, e),
    updatePlan: (id, p) => store.updatePlan(id, p),
    addUsage: (id, u) => store.addUsage(id, u),
    ackInbox: (id, ids) => store.ackInbox(id, ids),
    heartbeat: (id) => store.heartbeat(id),
    setStatus: async (id, change) => {
      const applied = await store.setStatus(id, change);
      await after(change);
      return applied;
    },
  };
}

describe("Worker: the lease timer racing the end of a run", () => {
  it("a heartbeat that fails because the run just finished does not turn it into lease_lost", async () => {
    const w = makeWorld();
    const runId = w.newRun(new FakeProvider([say("Done.")]));
    // The renewal tick lands after the terminal status was written (which released the lease) and
    // before the loop returns to the worker.
    const worker = w.worker("w1", {}, (store) =>
      afterSetStatus(store, async (change) => {
        if (change.to === "done") await w.clock.advance(1000);
      }),
    );
    worker.start();
    await w.clock.flush(100);
    expect(await statusOf(w, runId)).toBe("done");
    expect(w.ends).toEqual([
      expect.objectContaining({ runId, outcome: "settled", status: "done" }),
    ]);
    expect(w.errors).toEqual([]);
    expect(w.store.leaseHolder(runId)).toBeNull();
    await worker.stop();
  });

  it("same for a run that pauses for the user while an answer is already waiting (the pause requeues it)", async () => {
    const w = makeWorld();
    let post: (() => void) | undefined;
    const runId = w.newRun(
      new FakeProvider([
        async () => {
          post?.();
          return use(call("c1", "escalate", { question: "Which?" }));
        },
        say("Done."),
      ]),
    );
    post = () => w.store.postInbox(runId, { kind: "user_message", text: "Blue." });
    const worker = w.worker("w1", {}, (store) =>
      afterSetStatus(store, async (change) => {
        if (change.to === "waiting_user") await w.clock.advance(1000);
      }),
    );
    worker.start();
    await w.clock.flush(100);
    expect(w.ends[0]).toMatchObject({ runId, outcome: "settled", status: "waiting_user" });
    expect(w.errors).toEqual([]);
    // The run went back to the queue with its answer and finishes on the next claim.
    await w.clock.advance(1000);
    expect(await statusOf(w, runId)).toBe("done");
    await worker.stop();
  });

  it("a lease lost mid-run is still reported as lease_lost, and the loop is stopped", async () => {
    const w = makeWorld();
    const runId = w.newRun(hangingAt(new FakeProvider([say("never")]), 0));
    const worker = w.worker("w1");
    worker.start();
    await w.clock.flush(100);
    w.store.releaseLease(runId, "w1");
    w.store.claimNext("w2");
    await w.clock.advance(1000);
    expect(w.ends).toEqual([{ runId, outcome: "lease_lost" }]);
    expect(w.queueReleases).toEqual([]);
    await worker.stop();
  });

  it("a tick right after the run starts (lease valid) renews it and changes nothing", async () => {
    const w = makeWorld();
    const runId = w.newRun(new FakeProvider([say("Done.")]));
    let ticked = false;
    const worker = w.worker("w1", {}, (store) => ({
      ...store,
      getRun: async (id) => {
        if (!ticked) {
          ticked = true;
          await w.clock.advance(1000);
        }
        return store.getRun(id);
      },
      listEvents: (id) => store.listEvents(id),
      peekInbox: (id) => store.peekInbox(id),
      appendEvent: (id, e) => store.appendEvent(id, e),
      updatePlan: (id, p) => store.updatePlan(id, p),
      addUsage: (id, u) => store.addUsage(id, u),
      ackInbox: (id, ids) => store.ackInbox(id, ids),
      heartbeat: (id) => store.heartbeat(id),
      setStatus: (id, c) => store.setStatus(id, c),
    }));
    worker.start();
    await w.clock.flush(100);
    expect(await statusOf(w, runId)).toBe("done");
    expect(w.ends).toEqual([expect.objectContaining({ outcome: "settled", status: "done" })]);
    expect(w.errors).toEqual([]);
    await worker.stop();
  });

  it("a stop that arrives just as the run writes its final status does not release a finished run", async () => {
    const w = makeWorld();
    const runId = w.newRun(new FakeProvider([say("Done.")]));
    let stopping: Promise<void> | undefined;
    const holder: { worker?: Worker } = {};
    holder.worker = w.worker("w1", {}, (store) =>
      afterSetStatus(store, (change) => {
        if (change.to === "done") stopping = holder.worker?.stop({ graceMs: 0 });
      }),
    );
    holder.worker.start();
    await w.clock.flush(100);
    await stopping;
    expect(await statusOf(w, runId)).toBe("done");
    expect(w.ends).toEqual([
      expect.objectContaining({ runId, outcome: "settled", status: "done" }),
    ]);
    expect(w.queueReleases).toEqual([]);
  });
});
