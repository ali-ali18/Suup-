import {
  type BotConfig,
  LeaseLostError,
  type LoopDeps,
  type RunEventData,
  rebuildState,
  runLoop,
  type StoredEvent,
  ToolRegistry,
  validateConversation,
} from "@suup/core";
import {
  CrashingStore,
  call,
  FakeProvider,
  type FakeStep,
  finishCall,
  InMemoryRunStore,
  MemoryExecutor,
  planCall,
  SimulatedCrash,
  say,
  testBot,
  testTools,
  use,
} from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { claimNextRun, getRun, PgRunStore, postInbox, requeueStaleRuns } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun, uniqueWorkerId } from "./kit.js";

const step = (id: string, status: "pending" | "in_progress" | "done" | "dropped") => ({
  id,
  title: `Step ${id}`,
  status,
});

const CRITERIA = ["notes.txt was written"];

/** plan -> parallel tools with a side effect -> a nudge -> harness rejection -> finish */
const script: FakeStep[] = [
  use(planCall("c1", [step("s1", "in_progress"), step("s2", "pending")])),
  use(
    call("c2", "echo", { text: "one" }),
    call("c3", "write_note", { name: "notes.txt", body: "hi" }),
  ),
  say("I think that is everything."),
  use(planCall("c4", [step("s1", "done"), step("s2", "done")])),
  use(finishCall("c5", "Done.")),
  use(finishCall("c6", "All done.", [{ criterion: "1", evidence: "write_note: wrote notes.txt" }])),
];

function depsFor(
  store: LoopDeps["store"],
  provider: FakeProvider,
  executor = new MemoryExecutor(),
  bot: BotConfig = testBot(),
): LoopDeps {
  const registry = new ToolRegistry();
  for (const tool of testTools()) registry.register(tool);
  return {
    store,
    provider,
    tools: registry,
    executor,
    bot,
    now: () => new Date(),
    sleep: async () => {},
  };
}

/** The log without timings, requests and positions that legitimately shift. */
function project(events: readonly StoredEvent[]): unknown[] {
  return events
    .filter((e) => e.type !== "model_request")
    .map((e) => {
      const payload: Record<string, unknown> = { ...e.payload };
      delete payload.durationMs;
      delete payload.uptoSeq;
      delete payload.botId; // the in-memory run has a made-up bot, the database one a real uuid
      return { type: e.type, ...payload };
    });
}

const INTERRUPTED = "interrupted — the result is unknown";
const isInterrupted = (item: unknown) =>
  (item as { type?: string }).type === "tool_result" &&
  String((item as { content?: string }).content).includes(INTERRUPTED);

describe.skipIf(!DATABASE_URL)(dbSuiteName("runLoop on PgRunStore"), () => {
  const ctx = useIsolatedDb();

  /** A queued run, claimed by a fresh worker. */
  async function claimed(input: { objective?: string; acceptanceCriteria?: string[] } = {}) {
    while (await claimNextRun(ctx.db, "drain")) {}
    const run = await makeRun(ctx.db, { objective: "Write the notes.", ...input });
    const workerId = uniqueWorkerId();
    const taken = await claimNextRun(ctx.db, workerId);
    expect(taken?.id).toBe(run.id);
    return { runId: run.id, workerId, store: new PgRunStore(ctx.db, { workerId }) };
  }

  /** The same scenario on the in-memory store, started `running` like a claimed run. */
  async function baseline(steps: FakeStep[] = script) {
    const memory = new InMemoryRunStore();
    const run = memory.createRun({
      objective: "Write the notes.",
      acceptanceCriteria: CRITERIA,
      status: "running",
    });
    const provider = new FakeProvider(steps);
    expect(await runLoop(depsFor(memory, provider), run.id)).toBe("done");
    return { events: await memory.listEvents(run.id), memory, run, provider };
  }

  it("runs a whole run through plan, tools, a nudge and finish, and the database agrees with the log", async () => {
    const { runId, store, workerId } = await claimed({ acceptanceCriteria: CRITERIA });
    const provider = new FakeProvider(script);
    const executor = new MemoryExecutor();
    expect(await runLoop(depsFor(store, provider, executor), runId)).toBe("done");

    // The tool really ran, once.
    expect(executor.files.get("/workspace/notes.txt")).toBe("hi");

    const row = await getRun(ctx.db, runId);
    expect(row).toMatchObject({
      status: "done",
      turns: provider.calls,
      inputTokens: provider.calls * 10,
      outputTokens: provider.calls * 5,
      lockedBy: null,
      lockedAt: null,
      failureOrigin: null,
      result: {
        summary: "All done.",
        evidence: [{ criterion: "1", evidence: "write_note: wrote notes.txt" }],
      },
    });
    expect(row?.plan).toEqual([step("s1", "done"), step("s2", "done")]);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.finishedAt).toBeInstanceOf(Date);

    const events = await store.listEvents(runId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)).toMatchObject({
      type: "status_changed",
      payload: { from: "running", to: "done" },
    });
    expect(validateConversation(rebuildState(events).messages)).toEqual([]);

    // Same behaviour as the in-memory store the loop tests use.
    const memory = await baseline();
    expect(project(events)).toEqual(project(memory.events));

    // The finished run is not resumed or changed by another loop.
    expect(await runLoop(depsFor(store, new FakeProvider([])), runId)).toBe("done");
    expect(workerId).toBeTruthy();
  });

  it("keeps a failure origin of model in the database", async () => {
    const { runId, store } = await claimed();
    // The model keeps answering with text and no tool call: the loop fails the run (origin model).
    const provider = new FakeProvider([
      use(planCall("c1", [step("s1", "in_progress")])),
      say("hmm"),
      say("hmm"),
      say("hmm"),
    ]);
    expect(await runLoop(depsFor(store, provider), runId)).toBe("failed");
    const row = await getRun(ctx.db, runId);
    expect(row).toMatchObject({ status: "failed", failureOrigin: "model" });
    expect(row?.failureDetail).toContain("without any tool call");
  });

  it("resumes after a crash at every possible point, on another worker, from Postgres alone", async () => {
    const base = await baseline();
    const baseProjection = project(base.events);
    let crashes = 0;
    let interruptedRuns = 0;

    for (let n = 0; n <= base.events.length; n++) {
      const first = await claimed({ acceptanceCriteria: CRITERIA });
      const executor = new MemoryExecutor();
      try {
        await runLoop(
          depsFor(new CrashingStore(first.store, n), new FakeProvider(script), executor),
          first.runId,
        );
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        crashes += 1;
      }

      // The first worker is presumed dead: its lease expires, another worker takes the run over.
      const finished = (await getRun(ctx.db, first.runId))?.status === "done";
      if (!finished) {
        await ctx.db.sql`
          update runs set locked_at = now() - interval '1 hour' where id = ${first.runId}`;
        expect(await requeueStaleRuns(ctx.db, { olderThanMs: 60_000 })).toContain(first.runId);
        const secondId = uniqueWorkerId();
        expect((await claimNextRun(ctx.db, secondId))?.id).toBe(first.runId);
        const second = new PgRunStore(ctx.db, { workerId: secondId });

        const done = (await first.store.listEvents(first.runId)).filter(
          (e) => e.type === "model_response",
        ).length;
        const status = await runLoop(
          depsFor(second, new FakeProvider(script.slice(done)), executor),
          first.runId,
        );
        expect(status, `status after a crash at event ${n}`).toBe("done");

        // The old worker, back from the dead, can write nothing.
        await expect(
          first.store.appendEvent(first.runId, {
            type: "nudge",
            payload: { reason: "r", text: "t" },
          }),
        ).rejects.toBeInstanceOf(LeaseLostError);
      }

      const resumed = project(await first.store.listEvents(first.runId));
      const label = `crash after ${n} events`;
      expect(resumed.length, label).toBe(baseProjection.length);
      let interrupted = 0;
      resumed.forEach((item, i) => {
        if (isInterrupted(item)) {
          interrupted += 1;
          expect((baseProjection[i] as { callId: string }).callId, label).toBe(
            (item as { callId: string }).callId,
          );
        } else {
          expect(item, `${label}, event ${i}`).toEqual(baseProjection[i]);
        }
      });
      if (interrupted > 0) interruptedRuns += 1;
      expect(interrupted, label).toBeLessThanOrEqual(1);
      const row = await getRun(ctx.db, first.runId);
      expect(row, label).toMatchObject({ status: "done", lockedBy: null });
      expect(row?.plan, label).toEqual([step("s1", "done"), step("s2", "done")]);
    }
    expect(crashes).toBeGreaterThan(5);
    expect(interruptedRuns).toBeGreaterThan(0);
  }, 60_000);

  describe("messages while the run works", () => {
    const withEscalate: FakeStep[] = [
      use(planCall("c1", [step("s1", "in_progress")])),
      use(call("c2", "echo", { text: "x" })),
      use(call("c3", "escalate", { question: "Which colour?" })),
      use(planCall("c4", [step("s1", "done")])),
      use(finishCall("c5", "Went with green.")),
    ];

    it("delivers a message posted while running exactly once, and acknowledges it", async () => {
      const { runId, store } = await claimed();
      const posted = await postInbox(ctx.db, runId, { kind: "user_message", text: "Also say hi." });
      expect(posted.requeued).toBe(false);
      const provider = new FakeProvider([use(call("c1", "echo", { text: "x" })), say("Hi.")]);
      expect(await runLoop(depsFor(store, provider), runId)).toBe("done");

      const events = await store.listEvents(runId);
      const delivered = events.filter((e) => e.type === "user_message");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.payload).toEqual({ text: "Also say hi.", inboxId: posted.id });
      expect(await store.peekInbox(runId)).toEqual([]);
      // The model saw it.
      const asked = JSON.stringify(provider.requests[0]?.messages);
      expect(asked).toContain("Also say hi.");
    });

    it("pauses for the user, resumes on the answer (a new claim), and finishes", async () => {
      const { runId, store, workerId } = await claimed();
      const provider = new FakeProvider(withEscalate);
      expect(await runLoop(depsFor(store, provider), runId)).toBe("waiting_user");
      expect((await getRun(ctx.db, runId))?.status).toBe("waiting_user");

      // Waiting for a person is not a stale worker.
      await ctx.db.sql`update runs set locked_at = now() - interval '1 day' where id = ${runId}`;
      expect(await requeueStaleRuns(ctx.db, { olderThanMs: 1000 })).not.toContain(runId);

      // A loop started on a waiting run with no answer changes nothing.
      expect(await runLoop(depsFor(store, new FakeProvider([])), runId)).toBe("waiting_user");

      const answer = await postInbox(ctx.db, runId, { kind: "user_message", text: "Green." });
      expect(answer.requeued).toBe(true);
      expect((await getRun(ctx.db, runId))?.status).toBe("queued");

      const secondId = uniqueWorkerId();
      expect((await claimNextRun(ctx.db, secondId))?.id).toBe(runId);
      const second = new PgRunStore(ctx.db, { workerId: secondId });
      expect(await runLoop(depsFor(second, provider), runId)).toBe("done");

      const events = await second.listEvents(runId);
      const result = events.find((e) => e.type === "tool_result" && e.payload.callId === "c3");
      expect(result?.payload).toMatchObject({ content: "Green.", inboxIds: [answer.id] });
      expect(events.filter((e) => e.type === "user_message")).toHaveLength(0);
      const statuses = events
        .filter((e) => e.type === "status_changed")
        .map((e) => `${(e.payload as { from: string }).from}>${(e.payload as { to: string }).to}`);
      expect(statuses).toEqual(["running>waiting_user", "waiting_user>running", "running>done"]);
      expect(await second.peekInbox(runId)).toEqual([]);
      expect(workerId).not.toBe(secondId);
    });

    it("an answer that arrives while the loop is going to wait is not lost", async () => {
      const { runId, store } = await claimed();
      // The user answers while the escalate call is being handled (the run is still `running`).
      const provider = new FakeProvider([
        use(call("c1", "escalate", { question: "Which colour?" })),
        say("Green it is."),
      ]);
      const original = store.appendEvent.bind(store);
      let posted = false;
      store.appendEvent = async (id: string, event: RunEventData) => {
        const result = await original(id, event);
        if (event.type === "escalated" && !posted) {
          posted = true;
          await postInbox(ctx.db, id, { kind: "user_message", text: "Green." });
        }
        return result;
      };
      expect(await runLoop(depsFor(store, provider), runId)).toBe("waiting_user");
      // The run went back to the queue instead of sleeping with the answer unread.
      expect((await getRun(ctx.db, runId))?.status).toBe("queued");

      const secondId = uniqueWorkerId();
      expect((await claimNextRun(ctx.db, secondId))?.id).toBe(runId);
      const second = new PgRunStore(ctx.db, { workerId: secondId });
      expect(await runLoop(depsFor(second, provider), runId)).toBe("done");
      const answers = (await second.listEvents(runId)).filter(
        (e) => e.type === "tool_result" && e.payload.content === "Green.",
      );
      expect(answers).toHaveLength(1);
    });

    it("a stop posted to a waiting run cancels it", async () => {
      const { runId, store } = await claimed();
      const provider = new FakeProvider(withEscalate);
      expect(await runLoop(depsFor(store, provider), runId)).toBe("waiting_user");
      const stop = await postInbox(ctx.db, runId, { kind: "stop" });
      const secondId = uniqueWorkerId();
      expect((await claimNextRun(ctx.db, secondId))?.id).toBe(runId);
      const second = new PgRunStore(ctx.db, { workerId: secondId });
      expect(await runLoop(depsFor(second, provider), runId)).toBe("cancelled");
      const row = await getRun(ctx.db, runId);
      expect(row).toMatchObject({ status: "cancelled", lockedBy: null });
      expect(await second.peekInbox(runId)).toEqual([]);
      const cancelled = (await second.listEvents(runId)).at(-1);
      expect(cancelled?.payload).toMatchObject({ to: "cancelled", inboxIds: [stop.id] });
    });
  });

  it("enforces the duration limit from the first claim, not from the latest", async () => {
    const { runId, workerId, store } = await claimed();
    // The run started two hours ago (as far as the database is concerned) and was requeued since.
    await ctx.db.sql`update runs set started_at = now() - interval '2 hours' where id = ${runId}`;
    const bot = testBot({ limits: { maxTurns: 50, maxDurationMs: 60 * 60 * 1000 } });
    const provider = new FakeProvider([say("never asked")]);
    expect(await runLoop(depsFor(store, provider, new MemoryExecutor(), bot), runId)).toBe(
      "failed",
    );
    expect(await getRun(ctx.db, runId)).toMatchObject({ status: "failed", failureOrigin: "limit" });
    expect(provider.calls).toBe(0);
    expect(workerId).toBeTruthy();
  });

  it("a worker that lost the lease stops without writing, and the new owner finishes the run", async () => {
    const { runId, store } = await claimed();
    // The first worker's model call is slow; meanwhile the lease goes stale and is taken over.
    const provider = new FakeProvider([
      async () => {
        await ctx.db.sql`update runs set locked_at = now() - interval '1 hour' where id = ${runId}`;
        await requeueStaleRuns(ctx.db, { olderThanMs: 60_000 });
        const other = uniqueWorkerId();
        await claimNextRun(ctx.db, other);
        return say("Too late.");
      },
    ]);
    await expect(runLoop(depsFor(store, provider), runId)).rejects.toBeInstanceOf(LeaseLostError);

    // The zombie wrote its request before the call and nothing after.
    const events = await store.listEvents(runId);
    expect(events.map((e) => e.type)).toEqual(["run_started", "model_request"]);
    const row = await getRun(ctx.db, runId);
    expect(row?.status).toBe("running");
    expect(row?.lockedBy).not.toBeNull();
  });
});
