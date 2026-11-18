import { type LoopDeps, type RunEnd, ToolRegistry, Worker, type WorkerOptions } from "@suup/core";
import {
  call,
  FakeProvider,
  hangingAt,
  MemoryExecutor,
  say,
  testBot,
  testTools,
  use,
} from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { claimNextRun, getRun, PgRunQueue, PgRunStore, postInbox } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun, uniqueWorkerId, until } from "./kit.js";

/** Real clock, short intervals: the database is real, so time is too. */
const FAST = {
  leaseRenewMs: 40,
  // Generous against a slow runner: a worker that is merely slow (renewals 40ms apart, a stall of
  // a second) must never look dead.
  staleAfterMs: 2000,
  requeueEveryMs: 60,
  idleBackoff: { minMs: 10, maxMs: 40 },
} as const;

// Every wait below is on a condition with a generous deadline, never on a fixed sleep.
describe.skipIf(!DATABASE_URL)(dbSuiteName("Worker on PgRunQueue"), { timeout: 60_000 }, () => {
  const ctx = useIsolatedDb();

  const registry = new ToolRegistry();
  for (const tool of testTools()) registry.register(tool);

  function build(providers: Map<string, FakeProvider | ReturnType<typeof hangingAt>>) {
    const ends: RunEnd[] = [];
    const errors: unknown[] = [];
    const workers: Worker[] = [];
    const make = (overrides: Partial<WorkerOptions> = {}): Worker => {
      const workerId = overrides.workerId ?? uniqueWorkerId();
      const worker = new Worker({
        workerId,
        queue: new PgRunQueue(ctx.db),
        ...FAST,
        onRunEnd: (end) => ends.push(end),
        onError: (error) => errors.push(error),
        buildDeps: async (runId): Promise<LoopDeps> => {
          const provider = providers.get(runId);
          if (provider === undefined) throw new Error(`no provider for ${runId}`);
          return {
            store: new PgRunStore(ctx.db, { workerId }),
            provider,
            tools: registry,
            executor: new MemoryExecutor(),
            bot: testBot(),
            now: () => new Date(),
            sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
          };
        },
        ...overrides,
      });
      workers.push(worker);
      return worker;
    };
    const stopAll = () => Promise.all(workers.map((w) => w.stop()));
    return { ends, errors, make, stopAll };
  }

  const statusOf = async (runId: string) => (await getRun(ctx.db, runId))?.status;
  const eventTypes = async (runId: string) =>
    (await new PgRunStore(ctx.db, { workerId: "reader" }).listEvents(runId)).map((e) => e.type);

  it("runs several runs through the Postgres queue, never more than `concurrency` at once", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const providers = new Map<string, FakeProvider>();
    let running = 0;
    let peak = 0;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const run = await makeRun(ctx.db, { objective: `run ${i}` });
      ids.push(run.id);
      providers.set(
        run.id,
        new FakeProvider([
          async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 40));
            running--;
            return say(`done ${i}`);
          },
        ]),
      );
    }
    const kit = build(providers);
    const worker = kit.make({ concurrency: 2 });
    worker.start();
    await until(
      async () => (await Promise.all(ids.map(statusOf))).every((s) => s === "done"),
      8000,
      "all runs done",
    );
    expect(peak).toBe(2);
    await until(() => kit.ends.length >= 6, 30_000, "every run to be reported");
    await kit.stopAll();
    expect(kit.errors).toEqual([]);
    expect(kit.ends.map((e) => e.outcome)).toEqual(Array(6).fill("settled"));
  });

  it("a graceful stop mid-run hands the run back, and a second worker finishes it", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "slow one" });
    const inner = new FakeProvider([use(call("c1", "echo", { text: "x" })), say("All done.")]);
    const providers = new Map([[run.id, hangingAt(inner, 1)]]);
    const kit = build(providers);

    const first = kit.make();
    first.start();
    await until(
      async () => (await eventTypes(run.id)).filter((t) => t === "model_request").length === 2,
    );
    await first.stop({ graceMs: 0 });
    expect(kit.ends).toEqual([{ runId: run.id, outcome: "released" }]);
    expect(await getRun(ctx.db, run.id)).toMatchObject({ status: "queued", lockedBy: null });

    const second = kit.make();
    second.start();
    await until(async () => (await statusOf(run.id)) === "done");
    const types = await eventTypes(run.id);
    expect(types.filter((t) => t === "tool_call")).toHaveLength(1);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(1);
    await kit.stopAll();
  });

  it("picks up a run whose worker died (stale lease) on another worker", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { status: "running", leasedTo: "dead", leaseAgeMs: 60_000 });
    const providers = new Map([[run.id, new FakeProvider([say("Recovered.")])]]);
    const kit = build(providers);
    const worker = kit.make();
    worker.start();
    await until(async () => (await statusOf(run.id)) === "done", 30_000, "the stale run to finish");
    expect((await getRun(ctx.db, run.id))?.startedAt).not.toBeNull();
    await kit.stopAll();
  });

  it("keeps a long model call alive with the lease timer, so nobody steals the run", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "long call" });
    const providers = new Map([
      [
        run.id,
        new FakeProvider([
          async () => {
            // Longer than the lease may go unrenewed: only the lease timer keeps the run alive.
            const until0 = Date.now() + FAST.staleAfterMs * 1.5;
            while (Date.now() < until0) await new Promise((r) => setTimeout(r, 20));
            return say("Finally.");
          },
        ]),
      ],
    ]);
    const kit = build(providers);
    const a = kit.make();
    const b = kit.make(); // a rival sweeping for stale runs the whole time
    a.start();
    await until(async () => (await getRun(ctx.db, run.id))?.status === "running");
    b.start();
    await until(async () => (await statusOf(run.id)) === "done", 30_000, "the long call to finish");
    // One worker ran it from start to end.
    expect(kit.ends.filter((e) => e.runId === run.id)).toHaveLength(1);
    expect(kit.ends[0]).toMatchObject({ outcome: "settled", status: "done" });
    await kit.stopAll();
  });

  it("drops a run whose lease was taken, writing nothing, and keeps serving others", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "doomed" });
    const providers = new Map<string, FakeProvider | ReturnType<typeof hangingAt>>([
      [run.id, hangingAt(new FakeProvider([say("never")]), 0)],
    ]);
    const kit = build(providers);
    const worker = kit.make();
    worker.start();
    await until(async () => (await getRun(ctx.db, run.id))?.status === "running");
    await until(async () => (await eventTypes(run.id)).includes("model_request"));
    const before = await eventTypes(run.id);

    await ctx.db.sql`update runs set locked_by = 'usurper' where id = ${run.id}`;
    await until(() => kit.ends.some((e) => e.outcome === "lease_lost"), 30_000, "lease_lost");
    expect(await eventTypes(run.id)).toEqual(before);
    expect(await getRun(ctx.db, run.id)).toMatchObject({ status: "running", lockedBy: "usurper" });

    const next = await makeRun(ctx.db, { objective: "after" });
    providers.set(next.id, new FakeProvider([say("fine")]));
    await until(async () => (await statusOf(next.id)) === "done");
    await kit.stopAll();
  });

  it("marks a run failed (harness) when its dependencies cannot be built, with the event in the log", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "no provider" });
    const kit = build(new Map());
    const worker = kit.make();
    worker.start();
    await until(async () => (await statusOf(run.id)) === "failed");
    expect(await getRun(ctx.db, run.id)).toMatchObject({
      failureOrigin: "harness",
      failureDetail: `no provider for ${run.id}`,
      lockedBy: null,
    });
    expect(await eventTypes(run.id)).toEqual(["status_changed"]);
    expect(kit.ends).toEqual([expect.objectContaining({ runId: run.id, outcome: "failed" })]);
    await kit.stopAll();
  });

  it("resumes a run that waits for the user when the answer is posted", async () => {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "ask me" });
    const providers = new Map([
      [
        run.id,
        new FakeProvider([use(call("c1", "escalate", { question: "Which?" })), say("Blue it is.")]),
      ],
    ]);
    const kit = build(providers);
    const sweeps = { count: 0 };
    const inner = new PgRunQueue(ctx.db);
    const worker = kit.make({
      queue: {
        claimNext: (id) => inner.claimNext(id),
        release: (id) => inner.release(id),
        fail: (id, f) => inner.fail(id, f),
        requeueStale: async (ms) => {
          sweeps.count += 1;
          return inner.requeueStale(ms);
        },
      },
    });
    worker.start();
    await until(async () => (await statusOf(run.id)) === "waiting_user");
    // Waiting is stable: nobody requeues it. Wait for several sweeps to have happened, not for time.
    const before = sweeps.count;
    await until(() => sweeps.count >= before + 3, 30_000, "three stale sweeps");
    expect(await statusOf(run.id)).toBe("waiting_user");

    await postInbox(ctx.db, run.id, { kind: "user_message", text: "Blue." });
    await until(async () => (await statusOf(run.id)) === "done");
    expect((await eventTypes(run.id)).filter((t) => t === "user_message")).toHaveLength(0);
    await kit.stopAll();
  });
});
