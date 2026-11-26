import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cancelRun,
  claimNextRun,
  createBot,
  createDirectConversation,
  getActiveConversationRun,
  getRun,
  listRunEvents,
  MIGRATIONS_DIR,
  migrate,
  postInbox,
  RunControlError,
  releaseRun,
  sendConversationMessage,
  setRunStatus,
  wakeDueRuns,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun } from "./kit.js";

const AT = new Date("2026-11-19T20:00:00.000Z");

/** A parked run, as the loop leaves it: waiting_timer with its wake columns. */
async function parked(
  db: Parameters<typeof makeRun>[0],
  at = AT,
  note = "check the deploy",
  count = 1,
) {
  const run = await makeRun(db, { status: "running", leasedTo: "worker-a" });
  const done = await setRunStatus(db, run.id, {
    from: "running",
    to: "waiting_timer",
    wake: { at: at.toISOString(), note, count },
  });
  expect(done?.status).toBe("waiting_timer");
  return run;
}

describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0019: waiting_timer"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("keeps every run of before, adds the columns empty, and accepts the new status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0019" && f.endsWith(".sql"));
    expect(held).toEqual([
      "0019_waiting_timer.sql",
      "0020_memory_prompt_limit_items.sql",
      "0021_stale_approvals.sql",
      "0022_reception.sql",
      "0023_supervisor.sql",
      "0024_web_search_cache.sql",
      "0025_bot_avatar_style.sql",
      "0026_routines.sql",
      "0027_message_routine_ref.sql",
      "0028_connector_oauth_catalog.sql",
      "0029_routine_reminders.sql",
      "0030_files.sql",
      "0031_web_search_usage.sql",
      "0032_secrets_managed_by.sql",
      "0033_routine_events.sql",
      "0034_user_owner_name.sql",
      "0035_bot_color_palette.sql",
      "0036_secret_hosts.sql",
      "0037_message_event_seq.sql",
      "0038_approval_via_chat.sql",
    ]);
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);

    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
    await ctx.db.sql`
      insert into runs (bot_id, origin, objective, status) values
      (${bot?.id as string}, 'user', 'o1', 'waiting_user'),
      (${bot?.id as string}, 'routine', 'o2', 'done')`;

    expect(await migrate(ctx.db)).toEqual(held);

    const rows = await ctx.db.sql<
      { status: string; wake_at: Date | null; wake_note: string | null; wake_count: number }[]
    >`select status, wake_at, wake_note, wake_count from runs order by objective`;
    expect(rows).toEqual([
      { status: "waiting_user", wake_at: null, wake_note: null, wake_count: 0 },
      { status: "done", wake_at: null, wake_note: null, wake_count: 0 },
    ]);
    await ctx.db
      .sql`update runs set status = 'waiting_timer', wake_at = now() where objective = 'o1'`;
    // A wake time only makes sense while parked.
    await expect(
      ctx.db.sql`update runs set status = 'queued' where objective = 'o1'`,
    ).rejects.toThrow(/runs_wake_only_when_waiting_timer/);
    expect(await migrate(ctx.db)).toEqual([]);
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("waking the runs parked for a return"), () => {
  const ctx = useIsolatedDb();

  it("wakes only the runs that are due, writing wait_fired and requeueing in one step", async () => {
    const early = await parked(ctx.db, new Date("2026-11-19T20:00:00.000Z"), "early");
    const late = await parked(ctx.db, new Date("2026-11-19T21:00:00.000Z"), "late");

    const woken = await wakeDueRuns(ctx.db, { now: new Date("2026-11-19T20:30:00.000Z") });
    expect(woken).toEqual([{ runId: early.id, delayMs: 30 * 60_000 }]);

    const one = await getRun(ctx.db, early.id);
    expect(one).toMatchObject({
      status: "queued",
      lockedBy: null,
      wakeAt: null,
      wakeNote: null,
      wakeCount: 1,
    });
    const events = await listRunEvents(ctx.db, early.id);
    expect(events.filter((e) => e.type === "wait_fired").map((e) => e.payload)).toEqual([
      { at: "2026-11-19T20:00:00.000Z", note: "early", delayMs: 30 * 60_000 },
    ]);
    // The other one is untouched: still parked, with its time.
    expect(await getRun(ctx.db, late.id)).toMatchObject({
      status: "waiting_timer",
      wakeAt: new Date("2026-11-19T21:00:00.000Z"),
      wakeNote: "late",
    });
    expect(await listRunEvents(ctx.db, late.id)).toEqual([]);
    // A worker claims the woken run like any other queued run.
    expect((await claimNextRun(ctx.db, "worker-b"))?.id).toBe(early.id);
  });

  it("fires exactly once even when several workers wake at the same moment", async () => {
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await parked(ctx.db, AT, `n${i}`));
    const now = new Date(AT.getTime() + 1000);
    const passes = await Promise.all(Array.from({ length: 5 }, () => wakeDueRuns(ctx.db, { now })));
    const woken = passes.flat().map((w) => w.runId);
    // Every run woke, and none twice, whoever got it.
    expect([...woken].sort()).toEqual(runs.map((r) => r.id).sort());
    for (const run of runs) {
      const fired = (await listRunEvents(ctx.db, run.id)).filter((e) => e.type === "wait_fired");
      expect(fired, run.id).toHaveLength(1);
    }
    expect(await wakeDueRuns(ctx.db, { now })).toEqual([]);
  });

  it("one call wakes at most `limit` runs, the next takes the rest, oldest first", async () => {
    const a = await parked(ctx.db, new Date("2026-11-19T10:00:00.000Z"), "a");
    const b = await parked(ctx.db, new Date("2026-11-19T10:01:00.000Z"), "b");
    const c = await parked(ctx.db, new Date("2026-11-19T10:02:00.000Z"), "c");
    const now = new Date("2026-11-19T12:00:00.000Z");
    expect((await wakeDueRuns(ctx.db, { now, limit: 2 })).map((w) => w.runId)).toEqual([
      a.id,
      b.id,
    ]);
    expect((await wakeDueRuns(ctx.db, { now, limit: 2 })).map((w) => w.runId)).toEqual([c.id]);
  });

  it("wakes only the run asked for", async () => {
    const mine = await parked(ctx.db, AT, "mine");
    const other = await parked(ctx.db, AT, "other");
    const now = new Date(AT.getTime() + 1000);
    expect((await wakeDueRuns(ctx.db, { now, runId: mine.id })).map((w) => w.runId)).toEqual([
      mine.id,
    ]);
    expect((await getRun(ctx.db, other.id))?.status).toBe("waiting_timer");
  });

  it("uses the database clock when no instant is given", async () => {
    const run = await parked(ctx.db, new Date(Date.now() - 60_000), "past");
    expect((await wakeDueRuns(ctx.db, { runId: run.id })).map((w) => w.runId)).toEqual([run.id]);
    const future = await parked(ctx.db, new Date(Date.now() + 3_600_000), "future");
    expect(await wakeDueRuns(ctx.db, { runId: future.id })).toEqual([]);
  });

  it("a user message wakes a parked run through the inbox, and the return never fires", async () => {
    const run = await parked(ctx.db, AT, "x");
    const posted = await postInbox(ctx.db, run.id, { kind: "user_message", text: "olá" });
    expect(posted.requeued).toBe(true);
    expect(await getRun(ctx.db, run.id)).toMatchObject({
      status: "queued",
      wakeAt: null,
      wakeNote: null,
    });
    expect(
      await wakeDueRuns(ctx.db, { now: new Date(AT.getTime() + 1000), runId: run.id }),
    ).toEqual([]);
  });

  it("cancelling a parked run ends it right away and logs why", async () => {
    const run = await parked(ctx.db, AT, "x");
    const after = await cancelRun(ctx.db, run.id);
    expect(after).toMatchObject({ status: "cancelled", wakeAt: null });
    const events = await listRunEvents(ctx.db, run.id);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["wait_cancelled", { reason: "cancelled" }],
      ["status_changed", { from: "waiting_timer", to: "cancelled" }],
    ]);
    await expect(cancelRun(ctx.db, run.id)).rejects.toBeInstanceOf(RunControlError);
  });

  it("releasing a parked run (a requeue) clears its return", async () => {
    const run = await parked(ctx.db, AT, "x");
    expect(await releaseRun(ctx.db, run.id)).toMatchObject({ status: "queued", wakeAt: null });
  });

  it("a parked run is still the foreground run of its conversation: a message goes to it", async () => {
    const bot = await createBot(ctx.db, { name: "chat bot", modelProvider: "f", modelId: "m" });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const first = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "faça o deploy",
    });
    await ctx.db
      .sql`update runs set status = 'running', locked_by = 'w' where id = ${first.run.id}`;
    await setRunStatus(ctx.db, first.run.id, {
      from: "running",
      to: "waiting_timer",
      wake: { at: AT.toISOString(), note: "n", count: 0 },
    });
    expect((await getActiveConversationRun(ctx.db, conversation.id))?.id).toBe(first.run.id);
    const second = await sendConversationMessage(ctx.db, {
      conversationId: conversation.id,
      text: "esquece",
    });
    expect(second.queuedForRun).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe("queued");
  });
});
