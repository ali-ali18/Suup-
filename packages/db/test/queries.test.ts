import { describe, expect, it } from "vitest";
import {
  addRunUsage,
  appendRunEvent,
  archiveBot,
  type Bot,
  claimNextRun,
  createBot,
  createRun,
  getBot,
  getRun,
  listBots,
  listRunEvents,
  listRuns,
  type PlanStep,
  RunNotFoundError,
  releaseRun,
  setRunStatus,
  updateBot,
  updateRunPlan,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!DATABASE_URL)(dbSuiteName("data access"), () => {
  const ctx = useIsolatedDb();

  const newBot = (name = "bot"): Promise<Bot> =>
    createBot(ctx.db, { name, modelProvider: "fake", modelId: "fake-1" });
  const newRun = async (botId?: string, objective = "do it") =>
    createRun(ctx.db, { botId: botId ?? (await newBot()).id, origin: "user", objective });

  describe("bots", () => {
    it("creates with defaults and reads back", async () => {
      const bot = await createBot(ctx.db, { name: "Ana", modelProvider: "p", modelId: "m" });
      expect(bot).toMatchObject({
        name: "Ana",
        description: "",
        personality: "",
        modelProvider: "p",
        modelId: "m",
        allowedTools: [],
        limits: {},
        archivedAt: null,
      });
      expect(bot.createdAt).toBeInstanceOf(Date);
      expect(await getBot(ctx.db, bot.id)).toEqual(bot);
    });

    it("stores tools and limits, and getBot returns null for unknown ids", async () => {
      const bot = await createBot(ctx.db, {
        name: "Tooly",
        description: "d",
        personality: "calm",
        modelProvider: "p",
        modelId: "m",
        allowedTools: ["shell", "files"],
        limits: { maxTurns: 10, maxCostUsd: 1.5 },
      });
      expect(bot.allowedTools).toEqual(["shell", "files"]);
      expect(bot.limits).toEqual({ maxTurns: 10, maxCostUsd: 1.5 });
      expect(await getBot(ctx.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("rejects invalid limits at the boundary", async () => {
      await expect(
        createBot(ctx.db, {
          name: "x",
          modelProvider: "p",
          modelId: "m",
          limits: { maxTurns: -1 },
        }),
      ).rejects.toThrow();
    });

    it("updates only the given fields and bumps updated_at", async () => {
      const bot = await newBot("before");
      await sleep(5); // Date has millisecond resolution
      const updated = await updateBot(ctx.db, bot.id, { name: "after", allowedTools: ["a"] });
      expect(updated).toMatchObject({ name: "after", allowedTools: ["a"], modelId: "fake-1" });
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(bot.updatedAt.getTime());
      expect(await updateBot(ctx.db, bot.id, {})).toMatchObject({ name: "after" });
      expect(await updateBot(ctx.db, "00000000-0000-0000-0000-000000000000", { name: "x" })).toBe(
        null,
      );
    });

    it("archives, hides from listBots by default, and is idempotent", async () => {
      const bot = await newBot("to-archive");
      const archived = await archiveBot(ctx.db, bot.id);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      const again = await archiveBot(ctx.db, bot.id);
      expect(again?.archivedAt).toEqual(archived?.archivedAt);

      const active = await listBots(ctx.db);
      expect(active.map((b) => b.id)).not.toContain(bot.id);
      const all = await listBots(ctx.db, { includeArchived: true });
      expect(all.map((b) => b.id)).toContain(bot.id);
    });
  });

  describe("runs", () => {
    it("creates a queued run with defaults", async () => {
      const bot = await newBot();
      const run = await createRun(ctx.db, {
        botId: bot.id,
        origin: "routine",
        objective: "summarize",
        acceptanceCriteria: ["has summary"],
        traceId: "trace-1",
      });
      expect(run).toMatchObject({
        botId: bot.id,
        parentRunId: null,
        origin: "routine",
        objective: "summarize",
        acceptanceCriteria: ["has summary"],
        plan: [],
        status: "queued",
        failureOrigin: null,
        failureDetail: null,
        result: null,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: "0.000000",
        traceId: "trace-1",
        lockedBy: null,
        lockedAt: null,
        startedAt: null,
        finishedAt: null,
      });
      expect(await getRun(ctx.db, run.id)).toEqual(run);
    });

    it("links a parent run, and rejects unknown bots, bad origins", async () => {
      const parent = await newRun();
      const child = await createRun(ctx.db, {
        botId: parent.botId,
        parentRunId: parent.id,
        origin: "delegation",
        objective: "sub",
      });
      expect(child.parentRunId).toBe(parent.id);
      await expect(
        createRun(ctx.db, {
          botId: "00000000-0000-0000-0000-000000000000",
          origin: "user",
          objective: "x",
        }),
      ).rejects.toThrow(/foreign key|violates/i);
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        createRun(ctx.db, { botId: parent.botId, origin: "nope" as any, objective: "x" }),
      ).rejects.toThrow();
    });

    it("lists by bot and status, newest first, honoring limit", async () => {
      const bot = await newBot();
      const a = await newRun(bot.id, "a");
      const b = await newRun(bot.id, "b");
      const c = await newRun(bot.id, "c");
      await setRunStatus(ctx.db, c.id, { from: "queued", to: "cancelled" });
      await newRun(undefined, "other bot");

      const all = await listRuns(ctx.db, { botId: bot.id, limit: 10 });
      expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
      const queued = await listRuns(ctx.db, { botId: bot.id, status: "queued", limit: 10 });
      expect(queued.map((r) => r.id)).toEqual([b.id, a.id]);
      const one = await listRuns(ctx.db, { botId: bot.id, limit: 1 });
      expect(one.map((r) => r.id)).toEqual([c.id]);
    });

    it("updates the plan and validates it", async () => {
      const run = await newRun();
      const plan: PlanStep[] = [
        { id: "1", title: "first", status: "done", note: "ok" },
        { id: "2", title: "second", status: "pending" },
      ];
      const updated = await updateRunPlan(ctx.db, run.id, plan);
      expect(updated?.plan).toEqual(plan);
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        updateRunPlan(ctx.db, run.id, [{ id: "1", title: "t", status: "weird" as any }]),
      ).rejects.toThrow();
    });

    it("increments usage and keeps tokens as numbers and cost as a decimal string", async () => {
      const run = await newRun();
      await addRunUsage(ctx.db, run.id, { turns: 1, inputTokens: 1000, costUsd: 0.1 });
      const after = await addRunUsage(ctx.db, run.id, {
        turns: 2,
        inputTokens: 5_000_000_000, // beyond int32: proves the bigint column
        outputTokens: 7,
        costUsd: "0.2",
      });
      expect(after).toMatchObject({
        turns: 3,
        inputTokens: 5_000_001_000,
        outputTokens: 7,
        costUsd: "0.300000",
      });
      expect(typeof after?.inputTokens).toBe("number");
      expect((await addRunUsage(ctx.db, run.id, {}))?.turns).toBe(3);
    });

    it("concurrent usage increments are not lost", async () => {
      const run = await newRun();
      await Promise.all(
        Array.from({ length: 20 }, () => addRunUsage(ctx.db, run.id, { turns: 1, costUsd: 0.5 })),
      );
      const got = await getRun(ctx.db, run.id);
      expect(got).toMatchObject({ turns: 20, costUsd: "10.000000" });
    });
  });

  describe("claimNextRun", () => {
    it("takes the oldest queued run, leases it, and keeps the first started_at", async () => {
      // Drain whatever other tests left queued so "oldest" is well defined.
      while (await claimNextRun(ctx.db, "drain")) {}
      const bot = await newBot();
      const first = await newRun(bot.id, "first");
      const second = await newRun(bot.id, "second");

      const claimed = await claimNextRun(ctx.db, "worker-1");
      expect(claimed).toMatchObject({
        id: first.id,
        status: "running",
        lockedBy: "worker-1",
      });
      expect(claimed?.lockedAt).toBeInstanceOf(Date);
      expect(claimed?.startedAt).toBeInstanceOf(Date);

      const next = await claimNextRun(ctx.db, "worker-2");
      expect(next?.id).toBe(second.id);
      expect(await claimNextRun(ctx.db, "worker-3")).toBeNull();

      // Released and claimed again: started_at stays the original one.
      const released = await releaseRun(ctx.db, first.id);
      expect(released).toMatchObject({ status: "queued", lockedBy: null, lockedAt: null });
      const again = await claimNextRun(ctx.db, "worker-3");
      expect(again?.id).toBe(first.id);
      expect(again?.lockedBy).toBe("worker-3");
      expect(again?.startedAt).toEqual(claimed?.startedAt);
    });

    it("never hands the same run to two concurrent claimers", async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
      const bot = await newBot();
      const created = await Promise.all(
        Array.from({ length: 5 }, (_, i) => newRun(bot.id, `r${i}`)),
      );

      // Two claimers racing for a single run: exactly one wins.
      const [only] = created;
      if (!only) throw new Error("no run created");
      const one = await Promise.all([claimNextRun(ctx.db, "a"), claimNextRun(ctx.db, "b")]);
      expect(one.filter((r) => r !== null)).toHaveLength(2); // 5 queued, so both win...
      expect(new Set(one.map((r) => r?.id)).size).toBe(2); // ...but different runs

      // 3 left, 12 claimers: exactly 3 winners, all distinct.
      const many = await Promise.all(
        Array.from({ length: 12 }, (_, i) => claimNextRun(ctx.db, `w${i}`)),
      );
      const won = many.filter((r): r is NonNullable<typeof r> => r !== null);
      expect(won).toHaveLength(3);
      expect(new Set(won.map((r) => r.id)).size).toBe(3);
      const all = [...one, ...won].map((r) => r?.id);
      expect(new Set(all).size).toBe(5);
      expect(new Set(all)).toEqual(new Set(created.map((r) => r.id)));
    });

    it("with a single queued run, two simultaneous claims yield one run and one null", async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
      const run = await newRun();
      const results = await Promise.all([claimNextRun(ctx.db, "a"), claimNextRun(ctx.db, "b")]);
      expect(results.filter((r) => r !== null).map((r) => r?.id)).toEqual([run.id]);
      expect(results.filter((r) => r === null)).toHaveLength(1);
    });
  });

  describe("setRunStatus", () => {
    it("applies when the current status matches, and returns null when it does not", async () => {
      const run = await newRun();
      const mismatch = await setRunStatus(ctx.db, run.id, { from: "running", to: "done" });
      expect(mismatch).toBeNull();
      expect((await getRun(ctx.db, run.id))?.status).toBe("queued");

      const ok = await setRunStatus(ctx.db, run.id, {
        from: ["queued", "waiting_user"],
        to: "running",
      });
      expect(ok?.status).toBe("running");
      expect(ok?.finishedAt).toBeNull();
    });

    it("only one of two racing compare-and-sets wins", async () => {
      const run = await newRun();
      const results = await Promise.all([
        setRunStatus(ctx.db, run.id, { from: "queued", to: "cancelled" }),
        setRunStatus(ctx.db, run.id, { from: "queued", to: "running" }),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("terminal statuses set finished_at, clear the lease, and store the result", async () => {
      const bot = await newBot();
      await newRun(bot.id);
      while (true) {
        const c = await claimNextRun(ctx.db, "w");
        if (c && c.botId === bot.id) {
          expect(c.lockedBy).toBe("w");
          const done = await setRunStatus(ctx.db, c.id, {
            from: "running",
            to: "done",
            result: { summary: "ok", n: 1 },
          });
          expect(done).toMatchObject({
            status: "done",
            result: { summary: "ok", n: 1 },
            lockedBy: null,
            lockedAt: null,
            failureOrigin: null,
          });
          expect(done?.finishedAt).toBeInstanceOf(Date);
          break;
        }
        if (!c) throw new Error("expected to claim the run just created");
      }
    });

    it("keeps the lease and the result for non-terminal statuses", async () => {
      await newRun();
      const claimed = await claimNextRun(ctx.db, "w-keep");
      if (!claimed) throw new Error("nothing claimed");
      const waiting = await setRunStatus(ctx.db, claimed.id, {
        from: "running",
        to: "waiting_user",
      });
      expect(waiting).toMatchObject({ status: "waiting_user", lockedBy: "w-keep" });
      expect(waiting?.finishedAt).toBeNull();
    });

    it("requires failure exactly when moving to failed (runtime)", async () => {
      const run = await newRun();
      await expect(
        // @ts-expect-error `failure` is required when `to` is "failed"
        setRunStatus(ctx.db, run.id, { from: "queued", to: "failed" }),
      ).rejects.toThrow(/failure/);
      await expect(
        setRunStatus(ctx.db, run.id, {
          from: "queued",
          to: "done",
          // @ts-expect-error `failure` is not allowed unless `to` is "failed"
          failure: { origin: "tool", detail: "x" },
        }),
      ).rejects.toThrow(/failure/);
      expect((await getRun(ctx.db, run.id))?.status).toBe("queued");
    });

    it("records failure origin and detail, and clears them if the run leaves failed", async () => {
      const run = await newRun();
      const failed = await setRunStatus(ctx.db, run.id, {
        from: "queued",
        to: "failed",
        failure: { origin: "provider", detail: "rate limited" },
      });
      expect(failed).toMatchObject({
        status: "failed",
        failureOrigin: "provider",
        failureDetail: "rate limited",
      });
      expect(failed?.finishedAt).toBeInstanceOf(Date);

      const retried = await setRunStatus(ctx.db, run.id, { from: "failed", to: "queued" });
      expect(retried).toMatchObject({
        status: "queued",
        failureOrigin: null,
        failureDetail: null,
        finishedAt: null,
      });
    });

    it("the database itself enforces failure_origin iff status = failed", async () => {
      const run = await newRun();
      await expect(
        ctx.db.sql`update runs set status = 'failed' where id = ${run.id}`,
      ).rejects.toThrow(/runs_failure_origin_iff_failed/);
      await expect(
        ctx.db.sql`update runs set failure_origin = 'tool' where id = ${run.id}`,
      ).rejects.toThrow(/runs_failure_origin_iff_failed/);
      await expect(
        ctx.db.sql`update runs set status = 'failed', failure_origin = 'nope' where id = ${run.id}`,
      ).rejects.toThrow(/check/);
      await expect(
        ctx.db.sql`update runs set status = 'bogus' where id = ${run.id}`,
      ).rejects.toThrow(/check/);
    });
  });

  describe("releaseRun", () => {
    it("requeues a leased run but leaves finished runs alone", async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
      const run = await newRun();
      await claimNextRun(ctx.db, "dead-worker");
      const released = await releaseRun(ctx.db, run.id);
      expect(released).toMatchObject({ status: "queued", lockedBy: null, lockedAt: null });

      await setRunStatus(ctx.db, run.id, { from: "queued", to: "cancelled" });
      expect(await releaseRun(ctx.db, run.id)).toBeNull();
      expect((await getRun(ctx.db, run.id))?.status).toBe("cancelled");
    });
  });

  describe("updated_at trigger", () => {
    it("moves forward on every update of bots and runs", async () => {
      const run = await newRun();
      await sleep(5); // Date has millisecond resolution
      const next = await addRunUsage(ctx.db, run.id, { turns: 1 });
      expect(next?.updatedAt.getTime()).toBeGreaterThan(run.updatedAt.getTime());
      expect(next?.createdAt).toEqual(run.createdAt);
    });
  });

  describe("run events", () => {
    it("appends gapless seq values starting at 1, per run", async () => {
      const a = await newRun();
      const b = await newRun();
      const e1 = await appendRunEvent(ctx.db, a.id, "state_change", { to: "running" });
      const e2 = await appendRunEvent(ctx.db, a.id, "model_response");
      const f1 = await appendRunEvent(ctx.db, b.id, "state_change");
      expect([e1.seq, e2.seq, f1.seq]).toEqual([1, 2, 1]);
      expect(e1).toMatchObject({ runId: a.id, type: "state_change", payload: { to: "running" } });
      expect(e2.payload).toEqual({});
      expect(typeof e1.id).toBe("number");
      expect(e2.id).toBeGreaterThan(e1.id);
    });

    it("throws RunNotFoundError for an unknown run", async () => {
      await expect(
        appendRunEvent(ctx.db, "00000000-0000-0000-0000-000000000000", "x"),
      ).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it("produces gapless, unique seq under 20 concurrent appends to the same run", async () => {
      const run = await newRun();
      const events = await Promise.all(
        Array.from({ length: 20 }, (_, i) => appendRunEvent(ctx.db, run.id, "tick", { i })),
      );
      expect(events.map((e) => e.seq).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      const stored = await listRunEvents(ctx.db, run.id);
      expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(new Set(stored.map((e) => e.payload.i)).size).toBe(20);
    });

    it("lists with afterSeq (exclusive) and limit, ordered by seq", async () => {
      const run = await newRun();
      for (let i = 1; i <= 5; i++) await appendRunEvent(ctx.db, run.id, "e", { i });

      expect((await listRunEvents(ctx.db, run.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect((await listRunEvents(ctx.db, run.id, { afterSeq: 2 })).map((e) => e.seq)).toEqual([
        3, 4, 5,
      ]);
      expect(
        (await listRunEvents(ctx.db, run.id, { afterSeq: 1, limit: 2 })).map((e) => e.seq),
      ).toEqual([2, 3]);
      expect(await listRunEvents(ctx.db, run.id, { afterSeq: 5 })).toEqual([]);
    });

    it("rejects UPDATE, DELETE and TRUNCATE on run_events at the database level", async () => {
      const run = await newRun();
      const event = await appendRunEvent(ctx.db, run.id, "immutable", { a: 1 });
      await expect(
        ctx.db.sql`update run_events set type = 'changed' where id = ${event.id}`,
      ).rejects.toThrow(/append-only/);
      await expect(ctx.db.sql`delete from run_events where id = ${event.id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(ctx.db.sql`truncate run_events`).rejects.toThrow(/append-only/);
      const [still] = await listRunEvents(ctx.db, run.id);
      expect(still).toEqual(event);
    });
  });
});
