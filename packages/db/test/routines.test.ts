import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  appendRunEvent,
  createBot,
  createDirectConversation,
  createRoutine,
  createRun,
  deleteRoutine,
  finishRoutineFire,
  fireDueRoutines,
  getRoutine,
  getRoutineFireByRun,
  getUserSettings,
  listRoutineFires,
  listRoutines,
  listRunSources,
  MIGRATIONS_DIR,
  migrate,
  RoutineError,
  runRoutineNow,
  setRoutineState,
  setRunStatus,
  setUserTimeZone,
  updateRoutine,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const SP = "America/Sao_Paulo";
const NOW = new Date("2026-11-22T12:00:00.000Z"); // 09:00 in Sao Paulo, a Sunday
const daily8 = { kind: "daily", time: "08:00" } as const;

describe.skipIf(!DATABASE_URL)(dbSuiteName("routines (migration 0026)"), () => {
  const ctx = useIsolatedDb();
  const newBot = (name = "Agenda") =>
    createBot(ctx.db, { name, modelProvider: "p", modelId: "m", allowedTools: [] });
  const routineFor = async (botId: string, schedule: unknown = daily8, now = NOW) =>
    createRoutine(ctx.db, {
      botId,
      name: "Ver o calendário",
      instruction: "Veja meu calendário de hoje e me diga o que tenho.",
      schedule,
      timeZone: SP,
      createdBy: "bot",
      now,
    });

  it("creates a routine with its first fire in the user's zone (08:00 Sao Paulo is 11:00 UTC)", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    expect(routine).toMatchObject({
      botId: bot.id,
      status: "active",
      triggerKind: "schedule",
      timeZone: SP,
      state: "",
      costCapUsd: null,
      createdBy: "bot",
      lastFire: null,
    });
    expect(routine.nextRunAt?.toISOString()).toBe("2026-11-23T11:00:00.000Z");
    expect((await listRoutines(ctx.db, { botId: bot.id })).map((r) => r.id)).toEqual([routine.id]);
  });

  it("refuses cron text, an interval under 5 minutes, a bad zone and a date already past", async () => {
    const bot = await newBot();
    await expect(routineFor(bot.id, { kind: "cron", expression: "0 8 * * *" })).rejects.toThrow(
      RoutineError,
    );
    await expect(
      routineFor(bot.id, { kind: "interval", every: 4, unit: "minutes" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      createRoutine(ctx.db, {
        botId: bot.id,
        name: "x",
        instruction: "y",
        schedule: daily8,
        timeZone: "Mars/Olympus",
        createdBy: "user",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      routineFor(bot.id, { kind: "once", date: "2026-11-01", time: "08:00" }),
    ).rejects.toMatchObject({ code: "never_fires" });
  });

  it("fires once when due, with a fresh routine run outside any conversation", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    const due = new Date("2026-11-23T11:00:20.000Z");
    const mine = async (now: Date) =>
      (await fireDueRoutines(ctx.db, { now })).filter((f) => f.routineId === routine.id);
    expect(await mine(new Date("2026-11-23T10:59:00Z"))).toEqual([]);
    const [fired, ...rest] = await mine(due);
    expect(rest).toEqual([]);
    expect(fired?.fire).toMatchObject({
      routineId: routine.id,
      kind: "scheduled",
      status: "running",
      missedCount: 0,
    });
    expect(fired?.fire.scheduledFor.toISOString()).toBe("2026-11-23T11:00:00.000Z");
    expect(fired?.run).toMatchObject({
      botId: bot.id,
      origin: "routine",
      conversationId: null,
      objective: routine.instruction,
      status: "queued",
    });
    // the same moment again (another worker, or after a crash) fires nothing
    expect(await mine(due)).toEqual([]);
    const after = await getRoutine(ctx.db, routine.id);
    expect(after?.nextRunAt?.toISOString()).toBe("2026-11-24T11:00:00.000Z");
    expect(after?.lastFire?.id).toBe(fired?.fire.id);
    expect((await getRoutineFireByRun(ctx.db, fired?.run?.id as string))?.id).toBe(fired?.fire.id);
  });

  it("two workers at the same instant: one fire", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    const due = new Date("2026-11-23T11:00:05.000Z");
    const results = await Promise.all([
      fireDueRoutines(ctx.db, { now: due }),
      fireDueRoutines(ctx.db, { now: due }),
      fireDueRoutines(ctx.db, { now: due }),
    ]);
    const mine = results.flat().filter((f) => f.routineId === routine.id);
    expect(mine).toHaveLength(1);
    expect(await listRoutineFires(ctx.db, routine.id)).toHaveLength(1);
  });

  it("missed times while off: ONE catch-up for the latest, the older ones counted", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    // off from the 23rd to the 26th, back at 15:00 UTC: 23, 24, 25 and 26 at 11:00 UTC passed
    const back = new Date("2026-11-26T15:00:00.000Z");
    const fired = (await fireDueRoutines(ctx.db, { now: back })).filter(
      (f) => f.routineId === routine.id,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.fire).toMatchObject({ kind: "catch_up", missedCount: 3, status: "running" });
    expect(fired[0]?.fire.scheduledFor.toISOString()).toBe("2026-11-26T11:00:00.000Z");
    expect((await getRoutine(ctx.db, routine.id))?.nextRunAt?.toISOString()).toBe(
      "2026-11-27T11:00:00.000Z",
    );
  });

  it("overlap: while the previous run goes on, the fire is skipped and recorded", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id, { kind: "interval", every: 5, unit: "minutes" });
    const first = (
      await fireDueRoutines(ctx.db, { now: new Date(NOW.getTime() + 5 * 60_000) })
    ).find((f) => f.routineId === routine.id);
    expect(first?.run).not.toBeNull();
    const second = (
      await fireDueRoutines(ctx.db, { now: new Date(NOW.getTime() + 10 * 60_000) })
    ).find((f) => f.routineId === routine.id);
    expect(second?.run).toBeNull();
    expect(second?.fire).toMatchObject({ status: "skipped", skipReason: "overlap" });
    await expect(runRoutineNow(ctx.db, routine.id)).rejects.toMatchObject({ code: "busy" });
    // the first run ends: the next time fires again
    await setRunStatus(ctx.db, first?.run?.id as string, { from: "queued", to: "running" });
    await setRunStatus(ctx.db, first?.run?.id as string, { from: "running", to: "done" });
    const third = (
      await fireDueRoutines(ctx.db, { now: new Date(NOW.getTime() + 15 * 60_000) })
    ).find((f) => f.routineId === routine.id);
    expect(third?.run).not.toBeNull();
  });

  it("a single date fires once and the routine ends; an end date stops it", async () => {
    const bot = await newBot();
    const once = await routineFor(bot.id, { kind: "once", date: "2026-11-25", time: "08:00" });
    await fireDueRoutines(ctx.db, { now: new Date("2026-11-25T11:00:01Z") });
    expect(await getRoutine(ctx.db, once.id)).toMatchObject({ status: "ended", nextRunAt: null });

    const ending = await routineFor(bot.id, { kind: "daily", time: "08:00", until: "2026-11-23" });
    await fireDueRoutines(ctx.db, { now: new Date("2026-11-23T11:00:01Z") });
    const ended = await getRoutine(ctx.db, ending.id);
    expect(ended?.status).toBe("ended");
    expect(ended?.endedAt).not.toBeNull();
  });

  it("pause clears the next fire, resume computes it from now; a new schedule re-anchors", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    const paused = await updateRoutine(ctx.db, routine.id, { paused: true, now: NOW });
    expect(paused).toMatchObject({ status: "paused", nextRunAt: null });
    expect(await fireDueRoutines(ctx.db, { now: new Date("2026-11-30T12:00:00Z") })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ routineId: routine.id })]),
    );
    const resumed = await updateRoutine(ctx.db, routine.id, {
      paused: false,
      now: new Date("2026-11-30T12:00:00Z"),
    });
    expect(resumed.nextRunAt?.toISOString()).toBe("2026-12-01T11:00:00.000Z");
    const moved = await updateRoutine(ctx.db, routine.id, {
      schedule: { kind: "weekly", days: ["mon"], time: "07:30" },
      name: "Calendário da semana",
      costCapUsd: "0.25",
      now: new Date("2026-11-30T12:00:00Z"),
    });
    expect(moved).toMatchObject({ name: "Calendário da semana", costCapUsd: "0.2500" });
    expect(moved.nextRunAt?.toISOString()).toBe("2026-12-07T10:30:00.000Z");
    await expect(
      updateRoutine(ctx.db, routine.id, {
        schedule: { kind: "once", date: "2026-01-01", time: "08:00" },
      }),
    ).rejects.toMatchObject({ code: "never_fires" });
  });

  it("the cost cap is plain decimal text only (no hex, binary, exponent, sign or spaces)", async () => {
    const bot = await newBot();
    const withCap = (costCapUsd: string) =>
      createRoutine(ctx.db, {
        botId: bot.id,
        name: "Teto",
        instruction: "Faça algo.",
        schedule: daily8,
        timeZone: SP,
        costCapUsd,
        createdBy: "user",
        now: NOW,
      });
    for (const bad of [
      "0x10",
      "0b11",
      "0o7",
      "1e3",
      " 1",
      "1 ",
      "-1",
      "+1",
      "0",
      "0.0000",
      "",
      ".",
      "1.",
      ".5",
      "1.2.3",
      "1.12345",
      "1.1234567",
      "Infinity",
      "NaN",
      "1234567",
    ]) {
      await expect(withCap(bad), bad).rejects.toMatchObject({
        name: "RoutineError",
        code: "invalid",
      });
    }
    const routine = await withCap("0.5");
    expect(routine.costCapUsd).toBe("0.5000");
    for (const [good, stored] of [
      ["2", "2.0000"],
      ["1.25", "1.2500"],
      ["0.0001", "0.0001"],
      ["999999.9999", "999999.9999"],
    ] as const) {
      const updated = await updateRoutine(ctx.db, routine.id, { costCapUsd: good, now: NOW });
      expect(updated.costCapUsd).toBe(stored);
    }
    await expect(
      updateRoutine(ctx.db, routine.id, { costCapUsd: "0x10", now: NOW }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await getRoutine(ctx.db, routine.id))?.costCapUsd).toBe("999999.9999");
  });

  it("a row with a broken schedule is listed as unusable, not a crash, and the scheduler pauses it once", async () => {
    const bot = await newBot("Quebrada");
    const good = await routineFor(bot.id);
    const bad = await routineFor(bot.id);
    // As an older version (or a hand edit) could have left it: valid JSON, not a schedule.
    await ctx.db.sql`
      update routines set schedule = ${ctx.db.sql.json({ kind: "cron", expression: "0 8 * * *" })}
      where id = ${bad.id}`;
    const listed = await listRoutines(ctx.db, { botId: bot.id });
    expect(listed.map((r) => [r.id, r.schedule === null, r.problem !== null])).toEqual([
      [good.id, false, false],
      [bad.id, true, true],
    ]);
    expect(await getRoutine(ctx.db, bad.id)).toMatchObject({ schedule: null, status: "active" });
    expect((await getRoutine(ctx.db, good.id))?.problem).toBeNull();

    const later = new Date("2026-11-23T11:00:30.000Z");
    const logged: string[] = [];
    const fired = await fireDueRoutines(ctx.db, { now: later, log: (m) => logged.push(m) });
    expect(fired.map((f) => f.routineId)).toContain(good.id);
    expect(fired.map((f) => f.routineId)).not.toContain(bad.id);
    expect(logged).toHaveLength(1);
    expect(await getRoutine(ctx.db, bad.id)).toMatchObject({ status: "paused", nextRunAt: null });
    // The next pass does not pick it up again.
    await fireDueRoutines(ctx.db, {
      now: new Date("2026-11-24T11:00:30.000Z"),
      log: (m) => logged.push(m),
    });
    expect(logged).toHaveLength(1);
    expect(await listRoutineFires(ctx.db, bad.id)).toEqual([]);

    // It can be renamed while paused; resuming without a schedule says why; a new schedule fixes it.
    expect((await updateRoutine(ctx.db, bad.id, { name: "Consertar", now: later })).name).toBe(
      "Consertar",
    );
    await expect(
      updateRoutine(ctx.db, bad.id, { paused: false, now: later }),
    ).rejects.toMatchObject({ code: "invalid" });
    const fixed = await updateRoutine(ctx.db, bad.id, {
      schedule: daily8,
      paused: false,
      now: later,
    });
    expect(fixed).toMatchObject({ status: "active", problem: null, schedule: daily8 });
  });

  it("run now is a manual fire that keeps the schedule; state and finish are recorded", async () => {
    const bot = await newBot();
    const routine = await routineFor(bot.id);
    const fired = await runRoutineNow(ctx.db, routine.id, { now: NOW });
    expect(fired.fire).toMatchObject({ kind: "manual", status: "running" });
    expect((await getRoutine(ctx.db, routine.id))?.nextRunAt?.toISOString()).toBe(
      "2026-11-23T11:00:00.000Z",
    );
    const stated = await setRoutineState(ctx.db, routine.id, "visto até 22/11");
    expect(stated.state).toBe("visto até 22/11");
    expect(stated.stateUpdatedAt).not.toBeNull();
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const message = await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Hoje: dentista às 15h.",
      routineId: routine.id,
    });
    expect(message.routineId).toBe(routine.id);
    expect(
      await finishRoutineFire(ctx.db, {
        fireId: fired.fire.id,
        status: "done",
        resultText: "Hoje: dentista às 15h.",
        messageId: message.id,
      }),
    ).toBe(true);
    // once
    expect(
      await finishRoutineFire(ctx.db, {
        fireId: fired.fire.id,
        status: "failed",
        resultText: "x",
        messageId: null,
      }),
    ).toBe(false);
    const [last] = await listRoutineFires(ctx.db, routine.id);
    expect(last).toMatchObject({ status: "done", messageId: message.id });
  });

  it("an archived bot's routines do not fire; deleting removes the history", async () => {
    const bot = await newBot("Arquivado");
    const routine = await routineFor(bot.id);
    await ctx.db.sql`update bots set archived_at = now() where id = ${bot.id}`;
    const fired = await fireDueRoutines(ctx.db, { now: new Date("2026-11-23T11:00:01Z") });
    expect(fired.some((f) => f.routineId === routine.id)).toBe(false);
    expect(await deleteRoutine(ctx.db, routine.id)).toBe(true);
    expect(await deleteRoutine(ctx.db, routine.id)).toBe(false);
    expect(await getRoutine(ctx.db, routine.id)).toBeNull();
  });

  it("the user's time zone: the device fills the blank, the user's choice wins", async () => {
    expect(await getUserSettings(ctx.db)).toMatchObject({ timeZone: null, timeZoneSource: null });
    expect(await setUserTimeZone(ctx.db, { timeZone: SP, source: "device" })).toMatchObject({
      timeZone: SP,
      timeZoneSource: "device",
    });
    expect(
      await setUserTimeZone(ctx.db, { timeZone: "Europe/Lisbon", source: "device" }),
    ).toMatchObject({ timeZone: "Europe/Lisbon", timeZoneSource: "device" });
    await setUserTimeZone(ctx.db, { timeZone: SP, source: "user" });
    expect(
      await setUserTimeZone(ctx.db, { timeZone: "America/New_York", source: "device" }),
    ).toMatchObject({ timeZone: SP, timeZoneSource: "user" });
    await expect(
      setUserTimeZone(ctx.db, { timeZone: "Nowhere/City", source: "user" }),
    ).rejects.toMatchObject({ code: "invalid_time_zone" });
  });

  it("the sources of a run: the pages its tools declared and the tools that answered, each once", async () => {
    const bot = await newBot("Fontes");
    const run = await createRun(ctx.db, { botId: bot.id, origin: "routine", objective: "x" });
    const other = await createRun(ctx.db, { botId: bot.id, origin: "routine", objective: "y" });
    const result = (callId: string, extra: Record<string, unknown> = {}) => ({
      callId,
      outcome: "ok",
      content: "https://not-a-source.example/ is only text",
      isError: false,
      truncated: false,
      durationMs: 1,
      ...extra,
    });
    const page = { url: "https://g1.globo.com/agenda", title: "Agenda" };
    await appendRunEvent(ctx.db, run.id, "tool_call", { callId: "a", name: "web_read", args: {} });
    await appendRunEvent(ctx.db, run.id, "tool_result", result("a", { source: page }));
    await appendRunEvent(ctx.db, run.id, "tool_call", { callId: "b", name: "web_read", args: {} });
    await appendRunEvent(ctx.db, run.id, "tool_result", result("b", { source: page }));
    await appendRunEvent(ctx.db, run.id, "tool_call", { callId: "c", name: "conn_x__y", args: {} });
    await appendRunEvent(ctx.db, run.id, "tool_result", result("c"));
    // a call that failed is not a source
    await appendRunEvent(ctx.db, run.id, "tool_call", { callId: "d", name: "web_read", args: {} });
    await appendRunEvent(
      ctx.db,
      run.id,
      "tool_result",
      result("d", { isError: true, outcome: "tool_error", source: { url: "https://falhou.dev/" } }),
    );
    const sources = await listRunSources(ctx.db, [run.id, other.id]);
    expect(sources.get(run.id)).toEqual({ pages: [page], tools: ["web_read", "conn_x__y"] });
    expect(sources.has(other.id)).toBe(false);
    expect((await listRunSources(ctx.db, [])).size).toBe(0);
  });
});

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("migration 0026 on a database at 0024 (with the 0025 also pending)"),
  () => {
    const ctx = useIsolatedDb({ migrate: false });

    it("applies on a database at 0024 and keeps the messages", async () => {
      const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0025" && f.endsWith(".sql"));
      expect(held).toEqual([
        "0025_bot_avatar_style.sql",
        "0026_routines.sql",
        "0027_message_routine_ref.sql",
        "0028_connector_oauth_catalog.sql",
        "0029_routine_reminders.sql",
        "0031_web_search_usage.sql",
      ]);
      for (const file of held) await rm(join(dir, file));
      await migrate(ctx.db, dir);
      const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
      const conversation = await createDirectConversation(ctx.db, bot?.id as string);
      await ctx.db.sql`
      insert into messages (conversation_id, seq, author_kind, text) values
      (${conversation.id}, 1, 'user', 'oi')`;
      expect(await migrate(ctx.db)).toEqual(held);
      const [row] = await ctx.db.sql<
        { routine_id: string | null }[]
      >`select routine_id from messages`;
      expect(row?.routine_id).toBeNull();
      // the schedule is structured JSON, and the next fire exists only for an active routine
      await expect(ctx.db.sql`
      insert into routines (bot_id, name, instruction, schedule, time_zone, status, next_run_at, created_by, ended_at)
      values (${bot?.id as string}, 'n', 'i', '"0 8 * * *"'::jsonb, 'UTC', 'paused', now(), 'user', null)`).rejects.toThrow();
      expect(await migrate(ctx.db)).toEqual([]);
    });
  },
);

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("migration 0027: the routine a user message is about"),
  () => {
    const ctx = useIsolatedDb({ migrate: false });

    it("applies on a database at 0026, keeps the messages, and holds a reference only on a user message", async () => {
      const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0027" && f.endsWith(".sql"));
      expect(held).toEqual([
        "0027_message_routine_ref.sql",
        "0028_connector_oauth_catalog.sql",
        "0029_routine_reminders.sql",
        "0031_web_search_usage.sql",
      ]);
      for (const file of held) await rm(join(dir, file));
      await migrate(ctx.db, dir);
      const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
      const conversation = await createDirectConversation(ctx.db, bot?.id as string);
      await ctx.db.sql`
      insert into messages (conversation_id, seq, author_kind, text) values
      (${conversation.id}, 1, 'user', 'oi')`;
      expect(await migrate(ctx.db)).toEqual(held);
      const [old] = await ctx.db.sql<
        { routine_ref: string | null }[]
      >`select routine_ref from messages`;
      expect(old?.routine_ref).toBeNull();
      const routine = await createRoutine(ctx.db, {
        botId: bot?.id as string,
        name: "Manhã",
        instruction: "Veja.",
        schedule: daily8,
        timeZone: SP,
        createdBy: "bot",
        now: NOW,
      });
      const mine = await appendMessage(ctx.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: "Editar a rotina “Manhã”: muda pra 7h",
        routineRef: routine.id,
      });
      expect(mine.routineRef).toBe(routine.id);
      expect(mine.text).not.toContain(routine.id);
      // only on a message of the user
      await expect(
        appendMessage(ctx.db, {
          conversationId: conversation.id,
          authorKind: "system",
          text: "x",
          routineRef: routine.id,
        }),
      ).rejects.toThrow();
      await expect(ctx.db.sql`
      insert into messages (conversation_id, seq, author_kind, text, routine_ref) values
      (${conversation.id}, 9, 'system', 'x', ${routine.id})`).rejects.toThrow();
      // the routine goes, the message stays, without the reference
      await deleteRoutine(ctx.db, routine.id);
      const [after] = await ctx.db.sql<{ text: string; routine_ref: string | null }[]>`
      select text, routine_ref from messages where id = ${mine.id}`;
      expect(after).toEqual({ text: "Editar a rotina “Manhã”: muda pra 7h", routine_ref: null });
    });
  },
);
