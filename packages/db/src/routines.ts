// Owns the routines of the bots and their history (tables `routines` and `routine_fires`, migration
// 0026; docs/ROTINAS.md). The schedule is STRUCTURED (`@suup/core` schedule.ts): no cron text, no
// pattern. The worker's job (`fireDueRoutines`) takes the due routines with `FOR UPDATE SKIP
// LOCKED`, like the job that wakes the returns (wake.ts), and in ONE transaction per routine writes
// the fire, opens the run (origin `routine`) and moves `next_run_at`: any number of workers, and a
// crash at any point, give each scheduled time at most one fire (unique routine + time).
import {
  describeSchedule,
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
/** Pending one-time reminders one bot may have (they are not routines and do not count as one). */
export const MAX_REMINDERS_PER_BOT = 30;
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
  /**
   * `null` when the stored schedule is not valid any more (written by an older version, or by
   * hand): the routine is listed with `problem` and never fires until it gets a new schedule.
   */
  schedule: Schedule | null;
  /** Why the routine cannot run as it is (in Portuguese, for the user); `null` when it can. */
  problem: string | null;
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
  /**
   * A one-time reminder of the bot, not a routine (owner's decision, 23/11/2026): it fires once
   * through the same scheduler, is never listed in the panel or the API list, and is deleted after
   * it fires. Only `once` schedules.
   */
  reminder: boolean;
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
  reminder: boolean;
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

/** What a routine whose stored schedule is not valid says (docs/ROTINAS.md). */
export const BROKEN_SCHEDULE_PROBLEM =
  "O horário salvo desta rotina não é válido nesta versão, então ela não roda. Escolha um novo horário ou apague a rotina.";

function mapRoutine(row: RoutineRow): Routine {
  // One bad row must not break every list, page and scheduler pass: it is marked, not thrown.
  const parsed = scheduleSchema.safeParse(row.schedule);
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    instruction: row.instruction,
    triggerKind: row.trigger_kind,
    schedule: parsed.success ? parsed.data : null,
    problem: parsed.success ? null : BROKEN_SCHEDULE_PROBLEM,
    timeZone: row.time_zone,
    anchorAt: row.anchor_at,
    status: row.status,
    nextRunAt: row.next_run_at,
    state: row.state,
    stateUpdatedAt: row.state_updated_at,
    costCapUsd: row.cost_cap_usd,
    createdBy: row.created_by,
    createdRunId: row.created_run_id,
    reminder: row.reminder === true,
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
/** What `cost_cap_usd numeric(10, 4)` holds: up to 6 digits before the point, 4 after. */
export const COST_CAP_INTEGER_DIGITS = 6;
export const COST_CAP_DECIMALS = 4;

const DIGITS = "0123456789";

/**
 * Whether `text` is a plain positive decimal the column can hold: digits, at most one `.` with
 * digits on both sides, no sign, space, exponent or `0x`/`0b` prefix (which `Number` would
 * accept). Read character by character, no pattern (docs/REGRAS.md).
 */
export function isCostCapText(text: string): boolean {
  const [whole = "", fraction, ...rest] = text.split(".");
  if (rest.length > 0 || whole.length === 0 || whole.length > COST_CAP_INTEGER_DIGITS) return false;
  if (fraction !== undefined && (fraction.length === 0 || fraction.length > COST_CAP_DECIMALS)) {
    return false;
  }
  for (const char of whole + (fraction ?? "")) if (!DIGITS.includes(char)) return false;
  return Number(text) > 0;
}

/**
 * A cap given as a number (the API, the bot's tool) as the decimal text the column takes: rounded
 * to the column's 4 decimals, never in exponent form. `null` when it does not fit.
 */
export function costCapText(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = value.toFixed(COST_CAP_DECIMALS);
  return isCostCapText(text) ? text : null;
}

function parseCost(value: string): string {
  if (!isCostCapText(value)) {
    throw new RoutineError(
      "invalid",
      `Teto de custo inválido: use um valor positivo em dólares, só com algarismos e ponto (ex.: 0.50), com até ${COST_CAP_DECIMALS} casas decimais.`,
    );
  }
  return value;
}

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
  /** A one-time reminder (see `Routine.reminder`): only a `once` schedule. */
  reminder?: boolean;
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
      : parseCost(input.costCapUsd);
  const reminder = input.reminder === true;
  if (reminder && schedule.kind !== "once") {
    throw new RoutineError("invalid", "Um lembrete é de uma vez só: precisa de data e hora.");
  }
  return withTransaction(db, async (tx) => {
    const now = await clockOf(tx, input.now);
    const [bot] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from bots where id = ${input.botId} for no key update`;
    if (bot === undefined) throw new RoutineError("not_found", "O bot não existe.");
    if (bot.archived_at !== null) {
      throw new RoutineError("bot_archived", "O bot está arquivado.");
    }
    const [count] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from routines
      where bot_id = ${input.botId} and reminder = ${reminder}`;
    const max = reminder ? MAX_REMINDERS_PER_BOT : MAX_ROUTINES_PER_BOT;
    if ((count?.n ?? 0) >= max) {
      throw new RoutineError(
        "limit",
        reminder
          ? `Este bot já tem ${max} lembretes marcados. Espere um disparar ou apague um.`
          : `Este bot já tem ${max} rotinas. Apague uma antes de criar outra.`,
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
        cost_cap_usd, created_by, created_run_id, reminder)
      values (${input.botId}, ${name}, ${instruction}, ${tx.sql.json(schedule)}, ${timeZone},
        ${now}, ${next}, ${cost}, ${input.createdBy}, ${input.createdRunId ?? null}, ${reminder})
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

/**
 * The routines, oldest first; of one bot when `botId` is given. One-time reminders are internal
 * (never in the panel or the API list): they come only with `reminders: true` (the bot's own tools).
 */
export async function listRoutines(
  db: Db,
  options: { botId?: string; reminders?: boolean } = {},
): Promise<Routine[]> {
  const reminders = options.reminders === true ? db.sql`` : db.sql`and not r.reminder`;
  const rows = await db.sql<RoutineRow[]>`
    ${selectRoutines(db)}
    where true
    ${options.botId === undefined ? db.sql`` : db.sql`and r.bot_id = ${options.botId}`}
    ${reminders}
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
      : parseCost(input.costCapUsd);
  return withTransaction(db, async (tx) => {
    if (!z.uuid().safeParse(id).success)
      throw new RoutineError("not_found", "A rotina não existe.");
    const [row] = await tx.sql<RoutineRow[]>`
      select r.*, null as last_fire from routines r where r.id = ${id} for update`;
    if (row === undefined) throw new RoutineError("not_found", "A rotina não existe.");
    const current = mapRoutine(row);
    if (current.reminder && schedule !== undefined && schedule.kind !== "once") {
      throw new RoutineError("invalid", "Um lembrete é de uma vez só: precisa de data e hora.");
    }
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
    // A routine whose stored schedule is broken can be paused, renamed or deleted; to be active
    // it needs a new schedule.
    if (status === "active" && nextSchedule === null) {
      throw new RoutineError("invalid", BROKEN_SCHEDULE_PROBLEM);
    }
    if (status === "active" && nextSchedule !== null) {
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
        schedule = ${tx.sql.json((nextSchedule ?? row.schedule) as never)},
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

/**
 * The routines messages are about (`messages.routine_ref`), as the model is told: the id, the name
 * and the schedule in words. Routines that no longer exist are absent.
 */
export async function routineRefsOf(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string; schedule: string }>> {
  const out = new Map<string, { id: string; name: string; schedule: string }>();
  if (ids.length === 0) return out;
  const rows = await db.sql<{ id: string; name: string; schedule: unknown }[]>`
    select id, name, schedule from routines where id = any(${[...new Set(ids)]}::uuid[])`;
  for (const row of rows) {
    const parsed = scheduleSchema.safeParse(row.schedule);
    out.set(row.id, {
      id: row.id,
      name: row.name,
      schedule: parsed.success ? describeSchedule(parsed.data) : "",
    });
  }
  return out;
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
  options: {
    now?: Date;
    limit?: number;
    /** Told when a due routine has a broken schedule and is paused instead of fired. */
    log?: (message: string) => void;
  } = {},
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
      if (routine.schedule === null) {
        // A schedule this version cannot read: pause it (no next time) so the pass neither fails
        // nor picks it up again; the routine shows `problem` until the user gives a new schedule.
        await tx.sql`
          update routines set status = 'paused', next_run_at = null where id = ${routine.id}`;
        options.log?.(
          `Rotina ${routine.id} (${JSON.stringify(routine.name)}) pausada: o horário salvo não é válido.`,
        );
        continue;
      }
      const schedule = routine.schedule;
      const dueAt = routine.nextRunAt as Date;
      const ctx = { timeZone: routine.timeZone, anchor: routine.anchorAt };
      // Every scheduled time from `due` (included) to now: the latest one fires, the rest are missed.
      const window = fireTimesBetween(schedule, ctx, new Date(dueAt.getTime() - 1), now);
      const scheduledFor = window.last ?? dueAt;
      const missedCount = Math.max(0, window.count - 1);
      const late = now.getTime() - scheduledFor.getTime() > CATCH_UP_AFTER_MS;
      const result = await openFire(tx, routine, {
        scheduledFor,
        kind: missedCount > 0 || late ? "catch_up" : "scheduled",
        missedCount,
      });
      if (result !== null) fired.push(result);
      // A one-time reminder fires once, whatever its schedule says after now (it is then deleted).
      const next = routine.reminder ? null : nextFireAfter(schedule, ctx, now);
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
