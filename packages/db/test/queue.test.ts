import { describe, expect, it } from "vitest";
import {
  claimNextRun,
  getRun,
  hasPendingInbox,
  PgRunStore,
  peekInboxEntries,
  postInbox,
  RunNotFoundError,
  releaseLeasedRun,
  renewLease,
  requeueStaleRuns,
  setRunStatus,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun, uniqueWorkerId } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("queue"), () => {
  const ctx = useIsolatedDb();

  describe("claiming and started_at", () => {
    it("sets started_at on the first claim only, through release, stale requeue and a wait", async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
      const run = await makeRun(ctx.db);
      expect((await getRun(ctx.db, run.id))?.startedAt).toBeNull();

      const first = await claimNextRun(ctx.db, "w1");
      expect(first?.id).toBe(run.id);
      const startedAt = first?.startedAt;
      expect(startedAt).toBeInstanceOf(Date);
      await new Promise((r) => setTimeout(r, 15));

      // released and claimed again
      await releaseLeasedRun(ctx.db, run.id, "w1");
      expect((await claimNextRun(ctx.db, "w2"))?.startedAt).toEqual(startedAt);

      // lease goes stale, requeued, claimed again
      await ctx.db.sql`update runs set locked_at = now() - interval '1 hour' where id = ${run.id}`;
      expect(await requeueStaleRuns(ctx.db, { olderThanMs: 1000 })).toEqual([run.id]);
      expect((await claimNextRun(ctx.db, "w3"))?.startedAt).toEqual(startedAt);

      // waits for the user, answered, claimed again
      const store = new PgRunStore(ctx.db, { workerId: "w3" });
      await store.setStatus(run.id, { from: ["running"], to: "waiting_user" });
      await postInbox(ctx.db, run.id, { kind: "user_message", text: "go on" });
      const again = await claimNextRun(ctx.db, "w4");
      expect(again).toMatchObject({ id: run.id, status: "running", lockedBy: "w4" });
      expect(again?.startedAt).toEqual(startedAt);
      // and the store reports it to the loop for the duration limit
      expect((await new PgRunStore(ctx.db, { workerId: "w4" }).getRun(run.id)).startedAt).toEqual(
        startedAt,
      );
    });

    it("a run moved to running without a claim also gets its started_at, once", async () => {
      const run = await makeRun(ctx.db);
      const first = await setRunStatus(ctx.db, run.id, { from: "queued", to: "running" });
      expect(first?.startedAt).toBeInstanceOf(Date);
      await setRunStatus(ctx.db, run.id, { from: "running", to: "waiting_approval" });
      const second = await setRunStatus(ctx.db, run.id, {
        from: "waiting_approval",
        to: "running",
      });
      expect(second?.startedAt).toEqual(first?.startedAt);
    });
  });

  describe("requeueStaleRuns", () => {
    it("requeues running runs with an old lease, clears it, and leaves everything else alone", async () => {
      const stale = await makeRun(ctx.db, {
        status: "running",
        leasedTo: "dead",
        leaseAgeMs: 60_000,
      });
      const fresh = await makeRun(ctx.db, {
        status: "running",
        leasedTo: "alive",
        leaseAgeMs: 100,
      });
      const waitingUser = await makeRun(ctx.db, {
        status: "waiting_user",
        leasedTo: "old",
        leaseAgeMs: 3_600_000,
      });
      const waitingApproval = await makeRun(ctx.db, {
        status: "waiting_approval",
        leasedTo: "old",
        leaseAgeMs: 3_600_000,
      });
      const done = await makeRun(ctx.db, { status: "done" });
      const queued = await makeRun(ctx.db);

      const requeued = await requeueStaleRuns(ctx.db, { olderThanMs: 10_000 });
      expect(requeued).toEqual([stale.id]);

      const after = async (id: string) => getRun(ctx.db, id);
      expect(await after(stale.id)).toMatchObject({
        status: "queued",
        lockedBy: null,
        lockedAt: null,
      });
      expect((await after(stale.id))?.startedAt).not.toBeNull();
      expect(await after(fresh.id)).toMatchObject({ status: "running", lockedBy: "alive" });
      expect(await after(waitingUser.id)).toMatchObject({
        status: "waiting_user",
        lockedBy: "old",
      });
      expect(await after(waitingApproval.id)).toMatchObject({ status: "waiting_approval" });
      expect((await after(done.id))?.status).toBe("done");
      expect((await after(queued.id))?.status).toBe("queued");

      // Nothing left to do, and a second sweep changes nothing.
      expect(await requeueStaleRuns(ctx.db, { olderThanMs: 10_000 })).toEqual([]);
    });

    it("rejects a nonsense threshold", async () => {
      await expect(requeueStaleRuns(ctx.db, { olderThanMs: -1 })).rejects.toThrow();
      await expect(requeueStaleRuns(ctx.db, { olderThanMs: Number.NaN })).rejects.toThrow();
    });
  });

  describe("renewLease", () => {
    it("renews for the holder and only for the holder", async () => {
      const run = await makeRun(ctx.db, { status: "running", leasedTo: "me", leaseAgeMs: 30_000 });
      const before = (await getRun(ctx.db, run.id))?.lockedAt as Date;
      expect(await renewLease(ctx.db, run.id, "someone-else")).toBe(false);
      expect((await getRun(ctx.db, run.id))?.lockedAt).toEqual(before);
      expect(await renewLease(ctx.db, run.id, "me")).toBe(true);
      const after = (await getRun(ctx.db, run.id))?.lockedAt ?? before;
      expect(after.getTime()).toBeGreaterThan(before.getTime() + 20_000);
      expect(await renewLease(ctx.db, "00000000-0000-4000-8000-000000000000", "me")).toBe(false);
    });

    it("a stale-requeued run is not renewable by its old holder", async () => {
      const run = await makeRun(ctx.db, {
        status: "running",
        leasedTo: "slow",
        leaseAgeMs: 60_000,
      });
      await requeueStaleRuns(ctx.db, { olderThanMs: 1000 });
      expect(await renewLease(ctx.db, run.id, "slow")).toBe(false);
      const store = new PgRunStore(ctx.db, { workerId: "slow" });
      await expect(store.heartbeat(run.id)).rejects.toMatchObject({ name: "LeaseLostError" });
    });
  });

  describe("postInbox", () => {
    it("stores the item, and requeues a waiting run in the same step", async () => {
      const waiting = await makeRun(ctx.db, { status: "waiting_user", leasedTo: "w" });
      const posted = await postInbox(ctx.db, waiting.id, { kind: "user_message", text: "blue" });
      expect(posted).toMatchObject({ kind: "user_message", text: "blue", requeued: true });
      expect(posted.id).toMatch(/^\d+$/);
      expect(await getRun(ctx.db, waiting.id)).toMatchObject({
        status: "queued",
        lockedBy: null,
        lockedAt: null,
      });
      const running = await makeRun(ctx.db, { status: "running", leasedTo: "w" });
      expect((await postInbox(ctx.db, running.id, { kind: "stop" })).requeued).toBe(false);
      expect((await getRun(ctx.db, running.id))?.status).toBe("running");
    });

    it("a requeued waiting run can be claimed", async () => {
      while (await claimNextRun(ctx.db, "drain")) {}
      const waiting = await makeRun(ctx.db, { status: "waiting_user", leasedTo: "w" });
      await postInbox(ctx.db, waiting.id, { kind: "user_message", text: "blue" });
      expect(await claimNextRun(ctx.db, "next")).toMatchObject({
        id: waiting.id,
        status: "running",
      });
    });

    it("rejects an unknown run and malformed items, and stores nothing", async () => {
      await expect(
        postInbox(ctx.db, "00000000-0000-4000-8000-000000000000", { kind: "stop" }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
      const run = await makeRun(ctx.db);
      await expect(postInbox(ctx.db, run.id, { kind: "user_message" } as never)).rejects.toThrow();
      await expect(postInbox(ctx.db, run.id, { kind: "shout" } as never)).rejects.toThrow();
      expect(await peekInboxEntries(ctx.db, run.id)).toEqual([]);
    });

    it("never leaves a run asleep when a post races the loop going to wait", async () => {
      // Either order must end with the run claimable: the post sees `waiting_user` and requeues,
      // or the pause sees the pending item and requeues.
      for (let i = 0; i < 25; i++) {
        const worker = uniqueWorkerId();
        const run = await makeRun(ctx.db, { status: "running", leasedTo: worker });
        const store = new PgRunStore(ctx.db, { workerId: worker });
        await Promise.all([
          postInbox(ctx.db, run.id, { kind: "user_message", text: `answer ${i}` }),
          store.setStatus(run.id, { from: ["running"], to: "waiting_user", requeueIfInbox: true }),
        ]);
        expect((await getRun(ctx.db, run.id))?.status, `round ${i}`).toBe("queued");
        expect(await hasPendingInbox(ctx.db, run.id)).toBe(true);
      }
    });
  });
});
