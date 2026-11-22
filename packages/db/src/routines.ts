// Owns the routines of the bots and their history (tables `routines` and `routine_fires`, migration
// 0026; docs/ROTINAS.md). The schedule is STRUCTURED (`@suup/core` schedule.ts): no cron text, no
// pattern. The worker's job (`fireDueRoutines`) takes the due routines with `FOR UPDATE SKIP
// LOCKED`, like the job that wakes the returns (wake.ts), and in ONE transaction per routine writes
// the fire, opens the run (origin `routine`) and moves `next_run_at`: any number of workers, and a
// crash at any point, give each scheduled time at most one fire (unique routine + time).
import {
  fireTimesBetween,
  isKnownTimeZone,
  nextFireAfter,
  type Schedule,
  scheduleSchema,
} from "@suup/core";
import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { createRun } from "./runs.js";
import type { Run } from "./types.js";

export const ROUTINE_STATUSES = ["active", "paused", "ended"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];
export const ROUTINE_FIRE_KINDS = ["scheduled", "catch_up", "manual"] as const;
export type RoutineFireKind = (typeof ROUTINE_FIRE_KINDS)[number];
export const ROUTINE_FIRE_STATUSES = ["running", "done", "failed", "cancelled", "skipped"] as const;
export type RoutineFireStatus = (typeof ROUTINE_FIRE_STATUSES)[number];
/** Today a routine fires on a schedule; a monitor and a webhook are later kinds of trigger. */
export const ROUTINE_TRIGGER_KINDS = ["schedule"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const MAX_ROUTINE_NAME = 80;
export const MAX_ROUTINE_INSTRUCTION = 2000;
export const MAX_ROUTINE_STATE = 2000;
/** The most routines one bot may have (active, paused or ended). */
export const MAX_ROUTINES_PER_BOT = 30;
/** A fire this late (or with missed times before it) is recorded as a catch-up. */
export const CATCH_UP_AFTER_MS = 2 * 60_000;

export interface RoutineFire {
  id: string;
  routineId: string;
  /** The time the schedule asked for (for a manual run, the moment it was asked). */
  scheduledFor: Date;
  kind: RoutineFireKind;
  status: RoutineFireStatus;
  /** Why it did not run: the previous run of this routine was still going. */
  skipReason: "overlap" | null;
  /** Older scheduled times that were missed (the machine was off) and folded into this fire. */
  missedCount: number;
  runId: string | null;
  /** What the run ended with: the bot's summary, or why it failed. */
  resultText: string | null;
  /** The message in the bot's chat with the result. */
  messageId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface Routine {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  triggerKind: RoutineTriggerKind;
  schedule: Schedule;
  /** The IANA zone the schedule is read in (the user's when it was set). */
  timeZone: string;
  /** Where an interval counts its periods from. */
  anchorAt: Date;
  status: RoutineStatus;
  nextRunAt: Date | null;
  /** A small note the routine keeps between fires (`update_routine_state`). */
  state: string;
  stateUpdatedAt: Date | null;
  /** The most one run may cost, as a decimal string; `null`: no cap of its own. */
  costCapUsd: string | null;
  createdBy: "bot" | "user";
  createdRunId: string | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The most recent fire, if any. */
  lastFire: RoutineFire | null;
}

export type RoutineErrorCode =
  | "not_found"
  | "invalid"
  | "never_fires"
  | "busy"
  | "limit"
  | "bot_archived";

export class RoutineError extends Error {
  override name = "RoutineError";
  constructor(
    readonly code: RoutineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface FireRow {
  id: string;
  routine_id: string;
  scheduled_for: Date;
  kind: RoutineFireKind;
  status: RoutineFireStatus;
  skip_reason: "overlap" | null;
  missed_count: number;
  run_id: string | null;
  result_text: string | null;
  message_id: string | null;
  created_at: Date;
  finished_at: Date | null;
}

interface RoutineRow {
  id: string;
  bot_id: string;
  name: string;
  instruction: string;
  trigger_kind: RoutineTriggerKind;
  schedule: unknown;
  time_zone: string;
  anchor_at: Date;
  status: RoutineStatus;
  next_run_at: Date | null;
  state: string;
  state_updated_at: Date | null;
  cost_cap_usd: string | null;
  created_by: "bot" | "user";
  created_run_id: string | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_fire: FireRow | null;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

function mapFire(row: FireRow): RoutineFire {
  return {
    id: row.id,
    routineId: row.routine_id,
    scheduledFor: toDate(row.scheduled_for),
    kind: row.kind,
    status: row.status,
    skipReason: row.skip_reason,
    missedCount: row.missed_count,
    runId: row.run_id,
    resultText: row.result_text,
    messageId: row.message_id,
    createdAt: toDate(row.created_at),
    finishedAt: row.finished_at === null ? null : toDate(row.finished_at),
  };
}

function mapRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    instruction: row.instruction,
    triggerKind: row.trigger_kind,
    schedule: scheduleSchema.parse(row.schedule),
    timeZone: row.time_zone,
    anchorAt: row.anchor_at,
    status: row.status,
    nextRunAt: row.next_run_at,
    state: row.state,
    stateUpdatedAt: row.state_updated_at,
    costCapUsd: row.cost_cap_usd,
    createdBy: row.created_by,
    createdRunId: row.created_run_id,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastFire: row.last_fire === null || row.last_fire === undefined ? null : mapFire(row.last_fire),
  };
}

/** Every routine column, plus its latest fire as JSON (one query, no second round trip). */
function selectRoutines(db: Db) {
  return db.sql`
    select r.*, (
      select to_jsonb(f) from routine_fires f
      where f.routine_id = r.id order by f.created_at desc, f.id desc limit 1
    ) as last_fire
    from routines r`;
}

const nameSchema = z.string().trim().min(1).max(MAX_ROUTINE_NAME);
const instructionSchema = z.string().trim().min(1).max(MAX_ROUTINE_INSTRUCTION);
const costSchema = z
  .string()
  .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0 && v.trim() !== "", "valor positivo");

function checkZone(timeZone: string): string {
  const zone = timeZone.trim();
  if (!isKnownTimeZone(zone)) {
    throw new RoutineError("invalid", `"${timeZone}" não é um fuso horário IANA conhecido.`);
  }
  return zone;
}

function parseSchedule(value: unknown): Schedule {
  const parsed = scheduleSchema.safeParse(value);
  if (!parsed.success) {
    throw new RoutineError(
      "invalid",
      `Horário inválido: ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
    );
  }
  return parsed.data;
}

async function clockOf(db: Db, now: Date | undefined): Promise<Date> {
  if (now !== undefined) return now;
  const [row] = await db.sql<{ t: Date }[]>`select now() as t`;
  return (row as { t: Date }).t;
}

export interface CreateRoutineInput {
  botId: string;
  name: string;
  instruction: string;
  schedule: unknown;
  timeZone: string;
  costCapUsd?: string | null;
  createdBy: "bot" | "user";
  createdRunId?: string;
  /** The moment it is created (default: the database clock). The interval is anchored here. */
  now?: Date;
}

/** A new routine, active, with its first fire computed. Refuses a schedule that never fires. */
export async function createRoutine(db: Db, input: CreateRoutineInput): Promise<Routine> {
  const name = nameSchema.parse(input.name);
  const instruction = instructionSchema.parse(input.instruction);
  const schedule = parseSchedule(input.schedule);
  const timeZone = checkZone(input.timeZone);
  const cost =
    input.costCapUsd === undefined || input.costCapUsd === null
      ? null
      : costSchema.parse(input.costCapUsd);
  return withTransaction(db, async (tx) => {
    const now = await clockOf(tx, input.now);
    const [bot] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from bots where id = ${input.botId} for no key update`;
    if (bot === undefined) throw new RoutineError("not_found", "O bot não existe.");
    if (bot.archived_at !== null) {
      throw new RoutineError("bot_archived", "O bot está arquivado.");
    }
    const [count] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from routines where bot_id = ${input.botId}`;
    if ((count?.n ?? 0) >= MAX_ROUTINES_PER_BOT) {
      throw new RoutineError(
        "limit",
        `Este bot já tem ${MAX_ROUTINES_PER_BOT} rotinas. Apague uma antes de criar outra.`,
      );
    }
    const next = nextFireAfter(schedule, { timeZone, anchor: now }, now);
    if (next === null) {
      throw new RoutineError(
        "never_fires",
        "Esse horário já passou (ou a data de fim vem antes do primeiro disparo): a rotina nunca rodaria.",
      );
    }
    const [row] = await tx.sql<{ id: string }[]>`
      insert into routines (bot_id, name, instruction, schedule, time_zone, anchor_at, next_run_at,
        cost_cap_usd, created_by, created_run_id)
      values (${input.botId}, ${name}, ${instruction}, ${tx.sql.json(schedule)}, ${timeZone},
        ${now}, ${next}, ${cost}, ${input.createdBy}, ${input.createdRunId ?? null})
      returning id`;
    return requireRoutine(tx, (row as { id: string }).id);
  });
}

export async function getRoutine(db: Db, id: string): Promise<Routine | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.sql<RoutineRow[]>`${selectRoutines(db)} where r.id = ${id}`;
  return row === undefined ? null : mapRoutine(row);
}

async function requireRoutine(db: Db, id: string): Promise<Routine> {
  const routine = await getRoutine(db, id);
  if (routine === null) throw new RoutineError("not_found", "A rotina não existe.");
  return routine;
}

/** The routines, oldest first; of one bot when `botId` is given. */
export async function listRoutines(db: Db, options: { botId?: string } = {}): Promise<Routine[]> {
  const rows = await db.sql<RoutineRow[]>`
    ${selectRoutines(db)}
    ${options.botId === undefined ? db.sql`` : db.sql`where r.bot_id = ${options.botId}`}
    order by r.created_at, r.id`;
  return rows.map(mapRoutine);
}

export interface UpdateRoutineInput {
  name?: string;
  instruction?: string;
  schedule?: unknown;
  timeZone?: string;
  /** `null` removes the routine's own cap. */
  costCapUsd?: string | null;
  /** `true` pauses (nothing fires; missed times while paused are not caught up); `false` resumes. */
  paused?: boolean;
  now?: Date;
}

/**
 * Changes a routine. A new schedule or zone re-anchors it at `now` and computes the next fire; an
 * ended routine with a new schedule comes back to life. Pausing clears the next fire; resuming
 * computes it from `now` (what was missed while paused is not run).
 */
export async function updateRoutine(
  db: Db,
  id: string,
  input: UpdateRoutineInput,
): Promise<Routine> {
  const name = input.name === undefined ? undefined : nameSchema.parse(input.name);
  const instruction =
    input.instruction === undefined ? undefined : instructionSchema.parse(input.instruction);
  const schedule = input.schedule === undefined ? undefined : parseSchedule(input.schedule);
  const zone = input.timeZone === undefined ? undefined : checkZone(input.timeZone);
  const cost =
    input.costCapUsd === undefined || input.costCapUsd === null
      ? input.costCapUsd
      : costSchema.parse(input.costCapUsd);
  return withTransaction(db, async (tx) => {
    if (!z.uuid().safeParse(id).success)
      throw new RoutineError("not_found", "A rotina não existe.");
    const [row] = await tx.sql<RoutineRow[]>`
      select r.*, null as last_fire from routines r where r.id = ${id} for update`;
    if (row === undefined) throw new RoutineError("not_found", "A rotina não existe.");
    const current = mapRoutine(row);
    const now = await clockOf(tx, input.now);
    const nextSchedule = schedule ?? current.schedule;
    const nextZone = zone ?? current.timeZone;
    const rescheduled = schedule !== undefined || zone !== undefined;
    const anchor = rescheduled ? now : current.anchorAt;
    let status: RoutineStatus = current.status;
    if (input.paused === true && status !== "ended") status = "paused";
    if (input.paused === false && status === "paused") status = "active";
    if (rescheduled && status === "ended") status = input.paused === true ? "paused" : "active";
    let next: Date | null = null;
    if (status === "active") {
      const recompute = rescheduled || current.status !== "active" || current.nextRunAt === null;
      next = recompute
        ? nextFireAfter(nextSchedule, { timeZone: nextZone, anchor }, now)
        : current.nextRunAt;
      if (next === null) {
        if (rescheduled) {
          throw new RoutineError(
            "never_fires",
            "Esse horário já passou (ou a data de fim vem antes do primeiro disparo): a rotina nunca rodaria.",
          );
        }
        status = "ended";
      }
    }
    await tx.sql`
      update routines set
        name = ${name ?? current.name},
        instruction = ${instruction ?? current.instruction},
        schedule = ${tx.sql.json(nextSchedule)},
        time_zone = ${nextZone},
        anchor_at = ${anchor},
        status = ${status},
        next_run_at = ${next},
        cost_cap_usd = ${cost === undefined ? current.costCapUsd : cost},
        ended_at = ${status === "ended" ? (current.endedAt ?? now) : null}
      where id = ${id}`;
    return requireRoutine(tx, id);
  });
}

/** Deletes a routine and its history (its runs stay). Returns whether it existed. */
export async function deleteRoutine(db: Db, id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const rows = await db.sql`delete from routines where id = ${id} returning id`;
  return rows.length > 0;
}

/** Replaces the routine's own note (what it wants to remember for the next fire). */
export async function setRoutineState(db: Db, id: string, state: string): Promise<Routine> {
  const text = z.string().max(MAX_ROUTINE_STATE).parse(state);
  const rows = await db.sql`
    update routines set state = ${text}, state_updated_at = now() where id = ${id} returning id`;
  if (rows.length === 0) throw new RoutineError("not_found", "A rotina não existe.");
  return requireRoutine(db, id);
}

/** The fires of a routine, newest first. */
export async function listRoutineFires(
  db: Db,
  routineId: string,
  options: { limit?: number } = {},
): Promise<RoutineFire[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const rows = await db.sql<FireRow[]>`
    select * from routine_fires where routine_id = ${routineId}
    order by created_at desc, id desc limit ${limit}`;
  return rows.map(mapFire);
}

/** The fire a run belongs to (`null` for a run that is not a routine's). */
export async function getRoutineFireByRun(db: Db, runId: string): Promise<RoutineFire | null> {
  const [row] = await db.sql<FireRow[]>`select * from routine_fires where run_id = ${runId}`;
  return row === undefined ? null : mapFire(row);
}

/** Records how the run of a fire ended (once: a fire already finished is left as it is). */
export async function finishRoutineFire(
  db: Db,
  input: {
    fireId: string;
    status: "done" | "failed" | "cancelled";
    resultText: string;
    messageId: string | null;
  },
): Promise<boolean> {
  const rows = await db.sql`
    update routine_fires set status = ${input.status}, result_text = ${input.resultText},
      message_id = ${input.messageId}, finished_at = now()
    where id = ${input.fireId} and finished_at is null and status = 'running'
    returning id`;
  return rows.length > 0;
}

const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_user",
  "waiting_approval",
  "waiting_timer",
] as const;

/** The run of this routine that has not ended, if any (overlap: a new fire is skipped). */
async function activeRunOf(tx: Db, routineId: string): Promise<string | null> {
  const [row] = await tx.sql<{ run_id: string }[]>`
    select f.run_id from routine_fires f join runs r on r.id = f.run_id
    where f.routine_id = ${routineId} and r.status = any(${[...ACTIVE_RUN_STATUSES]}::text[])
    limit 1`;
  return row?.run_id ?? null;
}

/** What one pass of the scheduler did to one routine. */
export interface FiredRoutine {
  routineId: string;
  fire: RoutineFire;
  /** The run opened for it (`null` when the fire was skipped). */
  run: Run | null;
}

async function openFire(
  tx: Db,
  routine: { id: string; botId: string; instruction: string },
  fire: { scheduledFor: Date; kind: RoutineFireKind; missedCount: number },
): Promise<FiredRoutine | null> {
  const busy = await activeRunOf(tx, routine.id);
  if (busy !== null) {
    const [skipped] = await tx.sql<FireRow[]>`
      insert into routine_fires (routine_id, scheduled_for, kind, status, skip_reason, missed_count,
        finished_at)
      values (${routine.id}, ${fire.scheduledFor}, ${fire.kind}, 'skipped', 'overlap',
        ${fire.missedCount}, now())
      on conflict (routine_id, scheduled_for) do nothing
      returning *`;
    return skipped === undefined
      ? null
      : { routineId: routine.id, fire: mapFire(skipped), run: null };
  }
  const [opened] = await tx.sql<FireRow[]>`
    insert into routine_fires (routine_id, scheduled_for, kind, status, missed_count)
    values (${routine.id}, ${fire.scheduledFor}, ${fire.kind}, 'running', ${fire.missedCount})
    on conflict (routine_id, scheduled_for) do nothing
    returning *`;
  if (opened === undefined) return null;
  // A fresh run, outside any conversation (a background run): the instruction the user approved is
  // its objective; the routine's state, the time of the fire and the missed count reach the model
  // through the run's context (`context_loaded.routine`). The result is posted to the bot's chat
  // when the run ends (docs/ROTINAS.md).
  const run = await createRun(tx, {
    botId: routine.botId,
    origin: "routine",
    objective: routine.instruction,
  });
  const [linked] = await tx.sql<FireRow[]>`
    update routine_fires set run_id = ${run.id} where id = ${opened.id} returning *`;
  return { routineId: routine.id, fire: mapFire(linked as FireRow), run };
}

/**
 * One pass of the scheduler: every active routine whose `next_run_at` came (of a bot that is not
 * archived) fires. Policy (docs/ROTINAS.md, from the research):
 *
 * - several scheduled times passed while nothing ran (the machine was off): ONE fire, for the most
 *   recent, recorded as `catch_up` with `missedCount` = how many older ones were discarded;
 * - the previous run of the routine is still going: the fire is recorded as `skipped` (overlap),
 *   nothing queues up;
 * - the next fire is computed after `now` (never in the past); a schedule that has no next fire
 *   (a single date, or past its end date) ends the routine.
 *
 * Each routine is taken with `FOR UPDATE SKIP LOCKED`, and the fire, the run and the new
 * `next_run_at` are one transaction: at most one fire per scheduled time, with any number of
 * workers and after a crash.
 */
export async function fireDueRoutines(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<FiredRoutine[]> {
  const limit = options.limit ?? 20;
  return withTransaction(db, async (tx) => {
    const now = await clockOf(tx, options.now);
    const due = await tx.sql<RoutineRow[]>`
      select r.*, null as last_fire from routines r
      join bots b on b.id = r.bot_id
      where r.status = 'active' and r.next_run_at is not null and r.next_run_at <= ${now}
        and b.archived_at is null
      order by r.next_run_at, r.id
      limit ${limit}
      for update of r skip locked`;
    const fired: FiredRoutine[] = [];
    for (const row of due) {
      const routine = mapRoutine(row);
      const dueAt = routine.nextRunAt as Date;
      const ctx = { timeZone: routine.timeZone, anchor: routine.anchorAt };
      // Every scheduled time from `due` (included) to now: the latest one fires, the rest are missed.
      const window = fireTimesBetween(routine.schedule, ctx, new Date(dueAt.getTime() - 1), now);
      const scheduledFor = window.last ?? dueAt;
      const missedCount = Math.max(0, window.count - 1);
      const late = now.getTime() - scheduledFor.getTime() > CATCH_UP_AFTER_MS;
      const result = await openFire(tx, routine, {
        scheduledFor,
        kind: missedCount > 0 || late ? "catch_up" : "scheduled",
        missedCount,
      });
      if (result !== null) fired.push(result);
      const next = nextFireAfter(routine.schedule, ctx, now);
      await tx.sql`
        update routines set next_run_at = ${next},
          status = ${next === null ? "ended" : "active"},
          ended_at = ${next === null ? now : null}
        where id = ${routine.id}`;
    }
    return fired;
  });
}

/**
 * "Rodar agora": a fire outside the schedule (`manual`), for the moment it is asked. It does not
 * move the schedule. Refused (`busy`) while the previous run of the routine is still going.
 */
export async function runRoutineNow(
  db: Db,
  id: string,
  options: { now?: Date } = {},
): Promise<FiredRoutine> {
  return withTransaction(db, async (tx) => {
    if (!z.uuid().safeParse(id).success)
      throw new RoutineError("not_found", "A rotina não existe.");
    const [row] = await tx.sql<(RoutineRow & { archived_at: Date | null })[]>`
      select r.*, null as last_fire, b.archived_at from routines r join bots b on b.id = r.bot_id
      where r.id = ${id} for update of r`;
    if (row === undefined) throw new RoutineError("not_found", "A rotina não existe.");
    if (row.archived_at !== null) throw new RoutineError("bot_archived", "O bot está arquivado.");
    if ((await activeRunOf(tx, id)) !== null) {
      throw new RoutineError(
        "busy",
        "A execução anterior desta rotina ainda não terminou: espere ela acabar para rodar de novo.",
      );
    }
    const now = await clockOf(tx, options.now);
    const result = await openFire(tx, mapRoutine(row), {
      scheduledFor: now,
      kind: "manual",
      missedCount: 0,
    });
    if (result === null) {
      throw new RoutineError("busy", "Esta rotina acabou de ser disparada. Tente de novo.");
    }
    return result;
  });
}
