import { z } from "zod";
import type { Db } from "./client.js";
import { joinFragments } from "./sql-util.js";
import {
  acceptanceCriteriaSchema,
  FAILURE_ORIGINS,
  type FailureOrigin,
  type JsonValue,
  type PlanStep,
  planSchema,
  RUN_ORIGINS,
  RUN_STATUSES,
  type Run,
  type RunOrigin,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from "./types.js";

export interface RunRow {
  id: string;
  bot_id: string;
  parent_run_id: string | null;
  conversation_id: string | null;
  origin: RunOrigin;
  objective: string;
  acceptance_criteria: unknown;
  plan: unknown;
  status: RunStatus;
  failure_origin: FailureOrigin | null;
  failure_detail: string | null;
  result: JsonValue | null;
  turns: number;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
  trace_id: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    botId: row.bot_id,
    parentRunId: row.parent_run_id,
    conversationId: row.conversation_id,
    origin: row.origin,
    objective: row.objective,
    acceptanceCriteria: acceptanceCriteriaSchema.parse(row.acceptance_criteria),
    plan: planSchema.parse(row.plan),
    status: row.status,
    failureOrigin: row.failure_origin,
    failureDetail: row.failure_detail,
    result: row.result,
    turns: row.turns,
    // postgres.js returns bigint as string; token counts are mapped to numbers on purpose.
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    // numeric stays a decimal string on purpose (no float drift on money).
    costUsd: row.cost_usd,
    traceId: row.trace_id,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateRunInput {
  botId: string;
  parentRunId?: string;
  /** The conversation this run belongs to (a run opened by a message). */
  conversationId?: string;
  origin: RunOrigin;
  objective: string;
  acceptanceCriteria?: string[];
  plan?: PlanStep[];
  traceId?: string;
}

const originSchema = z.enum(RUN_ORIGINS);
const statusSchema = z.enum(RUN_STATUSES);

export async function createRun(db: Db, input: CreateRunInput): Promise<Run> {
  const origin = originSchema.parse(input.origin);
  const criteria = acceptanceCriteriaSchema.parse(input.acceptanceCriteria ?? []);
  const plan = planSchema.parse(input.plan ?? []);
  const [row] = await db.sql<RunRow[]>`
    insert into runs (bot_id, parent_run_id, conversation_id, origin, objective, acceptance_criteria, plan, trace_id)
    values (
      ${input.botId},
      ${input.parentRunId ?? null},
      ${input.conversationId ?? null},
      ${origin},
      ${input.objective},
      ${db.sql.json(criteria)},
      ${db.sql.json(plan)},
      ${input.traceId ?? null}
    )
    returning *`;
  if (!row) throw new Error("insert into runs returned no row");
  return mapRun(row);
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`select * from runs where id = ${id}`;
  return row ? mapRun(row) : null;
}

export interface ListRunsOptions {
  botId?: string;
  conversationId?: string;
  status?: RunStatus;
  limit: number;
}

/** Newest first. */
export async function listRuns(db: Db, opts: ListRunsOptions): Promise<Run[]> {
  const limit = z.number().int().positive().parse(opts.limit);
  const { sql } = db;
  const rows = await sql<RunRow[]>`
    select * from runs
    where ${opts.botId !== undefined ? sql`bot_id = ${opts.botId}` : sql`true`}
      and ${opts.conversationId !== undefined ? sql`conversation_id = ${opts.conversationId}` : sql`true`}
      and ${opts.status !== undefined ? sql`status = ${statusSchema.parse(opts.status)}` : sql`true`}
    order by created_at desc, id
    limit ${limit}`;
  return rows.map(mapRun);
}

/**
 * Atomically takes the oldest queued run (`FOR UPDATE SKIP LOCKED`), marks it running and leases
 * it to `workerId`. `started_at` is only set the first time. Returns `null` if nothing is queued.
 */
export async function claimNextRun(db: Db, workerId: string): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`
    update runs
    set status = 'running',
        locked_by = ${workerId},
        locked_at = now(),
        started_at = coalesce(started_at, now())
    where id = (
      select id from runs
      where status = 'queued'
      order by created_at, id
      limit 1
      for update skip locked
    )
    returning *`;
  return row ? mapRun(row) : null;
}

/**
 * Like `claimNextRun`, but for one given run: takes it only if it is `queued` (marks it running
 * and leases it to `workerId`). Returns `null` if it is not queued (or does not exist). It is how
 * a process that follows a single run (the CLI) works on that run without touching the rest of
 * the queue.
 */
export async function claimRun(db: Db, runId: string, workerId: string): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`
    update runs
    set status = 'running',
        locked_by = ${workerId},
        locked_at = now(),
        started_at = coalesce(started_at, now())
    where id = (
      select id from runs
      where id = ${runId} and status = 'queued'
      for update skip locked
    )
    returning *`;
  return row ? mapRun(row) : null;
}

export interface RunFailure {
  origin: FailureOrigin;
  detail: string;
}

interface SetRunStatusBase {
  /** The update only applies if the run's current status is one of these. */
  from: RunStatus | readonly RunStatus[];
  /** When given, replaces `result`; when omitted, `result` is left untouched. */
  result?: JsonValue;
}

/** `failure` is required exactly when `to` is `"failed"`. */
export type SetRunStatusInput =
  | (SetRunStatusBase & { to: "failed"; failure: RunFailure })
  | (SetRunStatusBase & { to: Exclude<RunStatus, "failed">; failure?: never });

/**
 * Compare-and-set on the status. Returns the updated run, or `null` if the run does not exist or
 * its status was not in `from`. It does not know which transitions are legal; that is up to the
 * caller (`core`).
 *
 * Moving to `running` sets `started_at` if it was never set. Terminal statuses (done, failed,
 * cancelled) set `finished_at` and clear the lease. Any other
 * target status clears `finished_at` (so retrying a failed run does not keep a stale end time)
 * and leaves the lease alone. Failure columns are written from `failure` and cleared otherwise.
 */
export async function setRunStatus(
  db: Db,
  runId: string,
  input: SetRunStatusInput,
): Promise<Run | null> {
  const { sql } = db;
  const to = statusSchema.parse(input.to);
  const from = (Array.isArray(input.from) ? input.from : [input.from]).map((s) =>
    statusSchema.parse(s),
  );
  if (from.length === 0) throw new TypeError("setRunStatus: `from` must not be empty");

  const failure = input.failure as RunFailure | undefined;
  if (to === "failed") {
    if (!failure) throw new TypeError("setRunStatus: `failure` is required when `to` is 'failed'");
    z.enum(FAILURE_ORIGINS).parse(failure.origin);
  } else if (failure !== undefined) {
    throw new TypeError("setRunStatus: `failure` is only allowed when `to` is 'failed'");
  }

  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(to);
  const sets = [
    sql`status = ${to}`,
    sql`failure_origin = ${failure?.origin ?? null}`,
    sql`failure_detail = ${failure?.detail ?? null}`,
    terminal ? sql`finished_at = now()` : sql`finished_at = null`,
  ];
  if (terminal) sets.push(sql`locked_by = null`, sql`locked_at = null`);
  // Running for the first time starts the clock the duration limit is measured from; later
  // transitions to running (after a wait or a requeue) keep it.
  if (to === "running") sets.push(sql`started_at = coalesce(started_at, now())`);
  if (input.result !== undefined) sets.push(sql`result = ${sql.json(input.result)}`);

  const [row] = await sql<RunRow[]>`
    update runs set ${joinFragments(sql, sets)}
    where id = ${runId} and status = any(${from}::text[])
    returning *`;
  return row ? mapRun(row) : null;
}

export async function updateRunPlan(db: Db, runId: string, plan: PlanStep[]): Promise<Run | null> {
  const parsed = planSchema.parse(plan);
  const [row] = await db.sql<RunRow[]>`
    update runs set plan = ${db.sql.json(parsed)} where id = ${runId} returning *`;
  return row ? mapRun(row) : null;
}

export interface RunUsageDelta {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD; a number or a decimal string. Stored with 6 decimal places. */
  costUsd?: number | string;
}

const nonNegInt = z.number().int().nonnegative();
const usageSchema = z.object({
  turns: z.exactOptional(nonNegInt),
  inputTokens: z.exactOptional(nonNegInt),
  outputTokens: z.exactOptional(nonNegInt),
  costUsd: z.exactOptional(
    z.union([z.number().nonnegative().finite(), z.string().regex(/^\d+(\.\d+)?$/)]),
  ),
});

/** Increments the counters atomically (never overwrites). Omitted fields count as 0. */
export async function addRunUsage(
  db: Db,
  runId: string,
  usage: RunUsageDelta,
): Promise<Run | null> {
  const u = usageSchema.parse(usage);
  const [row] = await db.sql<RunRow[]>`
    update runs set
      turns = turns + ${u.turns ?? 0}::integer,
      input_tokens = input_tokens + ${u.inputTokens ?? 0}::bigint,
      output_tokens = output_tokens + ${u.outputTokens ?? 0}::bigint,
      cost_usd = cost_usd + ${String(u.costUsd ?? 0)}::numeric
    where id = ${runId}
    returning *`;
  return row ? mapRun(row) : null;
}

/**
 * Puts a run back in the queue and clears its lease (for when a worker died). Does nothing to
 * runs that already finished: returns `null` for those and for unknown ids.
 */
export async function releaseRun(db: Db, runId: string): Promise<Run | null> {
  const [row] = await db.sql<RunRow[]>`
    update runs set status = 'queued', locked_by = null, locked_at = null
    where id = ${runId} and status not in ('done', 'failed', 'cancelled')
    returning *`;
  return row ? mapRun(row) : null;
}
