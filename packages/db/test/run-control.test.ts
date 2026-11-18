import { describe, expect, it } from "vitest";
import {
  cancelRun,
  claimNextRun,
  getRun,
  heartbeatRun,
  listRunEvents,
  pauseRun,
  peekInboxEntries,
  postInbox,
  RunControlError,
  releaseLeasedRun,
  requeueStaleRuns,
  resumeRun,
  setRunStatus,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun, uniqueWorkerId } from "./kit.js";

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("pause, interrupt, resume and cancel from outside"),
  () => {
    const ctx = useIsolatedDb();

    const drain = async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
    };

    it("a paused queued run is not claimed; resuming makes it claimable again", async () => {
      await drain();
      const run = await makeRun(ctx.db);
      const paused = await pauseRun(ctx.db, run.id);
      expect(paused.pausedAt).toBeInstanceOf(Date);
      expect(paused.status).toBe("queued");
      expect(await claimNextRun(ctx.db, "w")).toBeNull();

      const resumed = await resumeRun(ctx.db, run.id);
      expect(resumed.pausedAt).toBeNull();
      expect((await claimNextRun(ctx.db, "w"))?.id).toBe(run.id);
    });

    it("a running run keeps its lease while a pause is requested; the worker reads it on its heartbeat", async () => {
      await drain();
      const worker = uniqueWorkerId();
      const run = await makeRun(ctx.db, { status: "running", leasedTo: worker });
      expect(await heartbeatRun(ctx.db, run.id, worker)).toEqual({
        pause: false,
        interrupt: false,
      });

      const soft = await pauseRun(ctx.db, run.id);
      expect(soft).toMatchObject({ status: "running", lockedBy: worker });
      expect(soft.interruptRequestedAt).toBeNull();
      expect(await heartbeatRun(ctx.db, run.id, worker)).toEqual({ pause: true, interrupt: false });

      const hard = await pauseRun(ctx.db, run.id, { hard: true }); // escalates the same pause
      expect(hard.interruptRequestedAt).toBeInstanceOf(Date);
      expect(hard.pausedAt?.getTime()).toBe(soft.pausedAt?.getTime());
      expect(await heartbeatRun(ctx.db, run.id, worker)).toEqual({ pause: true, interrupt: true });

      // Somebody else holding the run is told it lost it.
      expect(await heartbeatRun(ctx.db, run.id, "someone-else")).toBeNull();

      // The worker obeys and gives the run back: queued, still paused, the interrupt is spent.
      await releaseLeasedRun(ctx.db, run.id, worker);
      expect(await getRun(ctx.db, run.id)).toMatchObject({
        status: "queued",
        pausedAt: expect.any(Date),
        interruptRequestedAt: null,
        lockedBy: null,
      });
      expect(await claimNextRun(ctx.db, "w")).toBeNull();
      await resumeRun(ctx.db, run.id);
      expect((await claimNextRun(ctx.db, "w"))?.id).toBe(run.id);
    });

    it("a stale requeue keeps the pause and drops the interrupt", async () => {
      await drain();
      const run = await makeRun(ctx.db, {
        status: "running",
        leasedTo: "dead",
        leaseAgeMs: 60_000,
      });
      await pauseRun(ctx.db, run.id, { hard: true });
      expect(await requeueStaleRuns(ctx.db, { olderThanMs: 30_000 })).toContain(run.id);
      expect(await getRun(ctx.db, run.id)).toMatchObject({
        status: "queued",
        pausedAt: expect.any(Date),
        interruptRequestedAt: null,
      });
    });

    it("refuses what cannot be paused or resumed, with a code", async () => {
      await drain();
      const finished = await makeRun(ctx.db, { status: "done" });
      const waiting = await makeRun(ctx.db, { status: "waiting_user" });
      const idle = await makeRun(ctx.db);
      const code = (p: Promise<unknown>) =>
        p.then(
          () => "no error",
          (e: unknown) => (e instanceof RunControlError ? e.code : String(e)),
        );
      expect(await code(pauseRun(ctx.db, finished.id))).toBe("finished");
      expect(await code(pauseRun(ctx.db, waiting.id))).toBe("not_pausable");
      expect(await code(pauseRun(ctx.db, "11111111-1111-4111-8111-111111111111"))).toBe(
        "not_found",
      );
      expect(await code(resumeRun(ctx.db, idle.id))).toBe("not_paused");
      expect(await code(resumeRun(ctx.db, finished.id))).toBe("finished");
      expect(await code(cancelRun(ctx.db, finished.id))).toBe("finished");
    });

    it("a pause ends when the run leaves queued/running (a finished or waiting run is never left 'paused')", async () => {
      await drain();
      const worker = uniqueWorkerId();
      const run = await makeRun(ctx.db, { status: "running", leasedTo: worker });
      await pauseRun(ctx.db, run.id, { hard: true });
      await setRunStatus(ctx.db, run.id, { from: "running", to: "waiting_user" });
      expect(await getRun(ctx.db, run.id)).toMatchObject({
        status: "waiting_user",
        pausedAt: null,
        interruptRequestedAt: null,
      });
      // The database also refuses the combination outright.
      await expect(
        ctx.db.sql`update runs set paused_at = now() where id = ${run.id}`,
      ).rejects.toThrow(/runs_pause_only_when_active/);
    });

    it("cancel posts the stop item, lifts the pause so a worker can apply it, and interrupts a working run", async () => {
      await drain();
      const queuedPaused = await makeRun(ctx.db);
      await pauseRun(ctx.db, queuedPaused.id);
      const cancelled = await cancelRun(ctx.db, queuedPaused.id);
      expect(cancelled).toMatchObject({
        status: "queued",
        pausedAt: null,
        interruptRequestedAt: null,
      });
      expect((await peekInboxEntries(ctx.db, queuedPaused.id)).map((i) => i.kind)).toEqual([
        "stop",
      ]);
      expect((await claimNextRun(ctx.db, "w"))?.id).toBe(queuedPaused.id);

      const worker = uniqueWorkerId();
      const working = await makeRun(ctx.db, { status: "running", leasedTo: worker });
      const asked = await cancelRun(ctx.db, working.id);
      expect(asked.interruptRequestedAt).toBeInstanceOf(Date);
      expect(await heartbeatRun(ctx.db, working.id, worker)).toEqual({
        pause: false,
        interrupt: true,
      });

      // A run that waits for the user is put back in the queue by the stop, to be applied.
      const waiting = await makeRun(ctx.db, { status: "waiting_user" });
      expect(await cancelRun(ctx.db, waiting.id)).toMatchObject({ status: "queued" });
    });

    it("cancels a run waiting for an approval directly, logging the status change", async () => {
      const run = await makeRun(ctx.db, { status: "waiting_approval" });
      const done = await cancelRun(ctx.db, run.id);
      expect(done).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
      const events = await listRunEvents(ctx.db, run.id);
      expect(events.map((e) => [e.type, e.payload.to])).toEqual([["status_changed", "cancelled"]]);
    });

    it("a stop already in the inbox plus pause: the message to a paused run waits for the resume", async () => {
      await drain();
      const run = await makeRun(ctx.db);
      await pauseRun(ctx.db, run.id);
      await postInbox(ctx.db, run.id, { kind: "user_message", text: "oi" });
      expect(await claimNextRun(ctx.db, "w")).toBeNull();
      expect(await peekInboxEntries(ctx.db, run.id)).toHaveLength(1);
    });
  },
);
