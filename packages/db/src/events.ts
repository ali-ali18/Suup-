import { LeaseLostError } from "@suup/core";
import { z } from "zod";
import { projectApprovalRequested } from "./approvals.js";
import type { Db } from "./client.js";
import { type EventPayload, eventPayloadSchema, type RunEvent } from "./types.js";

interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: unknown;
  created_at: Date;
}

function mapRunEvent(row: RunEventRow): RunEvent {
  return {
    id: Number(row.id),
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: eventPayloadSchema.parse(row.payload),
    createdAt: row.created_at,
  };
}

const NUL = String.fromCharCode(0);
const REPLACEMENT = "\uFFFD";

/**
 * Postgres JSONB refuses a NUL character (`\u0000`) in a string or a key. A command's output can
 * carry one (the bot printed a decompressed PDF stream), and the whole run failed with
 * "unsupported Unicode escape sequence". Every string and key of an event goes through here before
 * it is stored: the NUL becomes the replacement character, by splitting on the exact character.
 * Returns the same object when nothing needs changing.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes(NUL) ? value.split(NUL).join(REPLACEMENT) : value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = withoutNul(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cleanKey = withoutNul(key);
      const next = withoutNul(item);
      if (cleanKey !== key || next !== item) changed = true;
      out[cleanKey] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

export interface AppendRunEventOptions {
  /**
   * Fencing: append only while the run is leased to this worker; otherwise throw
   * `LeaseLostError` and write nothing. The check and the insert are in the same transaction,
   * under the same row lock.
   */
  leaseHolder?: string;
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

/**
 * Appends an event with the next `seq` (1, 2, 3, ... without gaps) for the run. Appends to the
 * same run are serialized by locking the run row (`FOR NO KEY UPDATE`, which does not block
 * foreign-key checks from other tables) inside the transaction, so concurrent callers queue up
 * instead of racing for the same `seq`. Throws `RunNotFoundError` for an unknown run, and
 * `LeaseLostError` when `opts.leaseHolder` is given and does not hold the lease.
 */
export async function appendRunEvent(
  db: Db,
  runId: string,
  type: string,
  payload: EventPayload = {},
  opts: AppendRunEventOptions = {},
): Promise<RunEvent> {
  const body = withoutNul(eventPayloadSchema.parse(payload));
  return db.sql.begin(async (tx) => {
    const locked = await tx<{ locked_by: string | null }[]>`
      select locked_by from runs where id = ${runId} for no key update`;
    const lock = locked[0];
    if (lock === undefined) throw new RunNotFoundError(runId);
    if (opts.leaseHolder !== undefined && lock.locked_by !== opts.leaseHolder) {
      throw new LeaseLostError(runId);
    }
    const [row] = await tx<RunEventRow[]>`
      insert into run_events (run_id, seq, type, payload)
      values (
        ${runId},
        (select coalesce(max(seq), 0) + 1 from run_events where run_id = ${runId}),
        ${type},
        ${tx.json(body)}
      )
      returning *`;
    if (!row) throw new Error("insert into run_events returned no row");
    // An event that delivers inbox items (the loop read them) marks the chat messages they carry
    // as delivered, in the same transaction: the log and the chat never disagree.
    const delivered = deliveredInboxIds(type, body);
    if (delivered.length > 0) {
      await tx`
        update messages set status = 'delivered'
        where status = 'sent'
          and id in (
            select message_id from run_inbox
            where run_id = ${runId} and id = any(${delivered}::bigint[]) and message_id is not null
          )`;
    }
    // The card the user will see is a projection of this event, written in the same transaction.
    if (type === "approval_requested") {
      await projectApprovalRequested(
        { sql: tx as unknown as Db["sql"], close: async () => {} },
        runId,
        body,
      );
    }
    return mapRunEvent(row);
  });
}

/** The inbox item ids an event delivers: `user_message`, the answer to `escalate`, a cancellation. */
function deliveredInboxIds(type: string, payload: EventPayload): string[] {
  const ids: unknown[] = [];
  if (type === "user_message") ids.push(payload.inboxId);
  else if (type === "tool_result" || type === "status_changed") {
    if (Array.isArray(payload.inboxIds)) ids.push(...payload.inboxIds);
  }
  return ids.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id));
}

export interface ListRunEventsOptions {
  /** Only events with `seq` greater than this (exclusive). Default: from the start. */
  afterSeq?: number;
  /** Default 500. */
  limit?: number;
  /** Only events of these types. */
  types?: readonly string[];
  /**
   * Leave out the heavy `model_request` payload (a request carries the whole conversation and the
   * tool list, and can be megabytes): the event keeps its place and gets a small summary instead
   * (`omitted: true`, `provider`, `model`, `purpose`, `messageCount`, `toolCount`, and `toolStats`
   * when the request has it: a few numbers, what the tool definitions cost). The database does the
   * cutting, so the megabytes never leave it.
   */
  slim?: boolean;
}

/** Events of a run ordered by `seq`. */
export async function listRunEvents(
  db: Db,
  runId: string,
  opts: ListRunEventsOptions = {},
): Promise<RunEvent[]> {
  const afterSeq = z
    .number()
    .int()
    .nonnegative()
    .parse(opts.afterSeq ?? 0);
  const limit = z
    .number()
    .int()
    .positive()
    .parse(opts.limit ?? 500);
  const { sql } = db;
  const types = opts.types === undefined ? undefined : z.array(z.string()).parse([...opts.types]);
  const payload =
    opts.slim === true
      ? sql`case when type = 'model_request' then jsonb_strip_nulls(jsonb_build_object(
              'omitted', true,
              'provider', payload -> 'provider',
              'model', payload -> 'model',
              'purpose', payload -> 'purpose',
              'messageCount', jsonb_array_length(payload -> 'messages'),
              'toolCount', jsonb_array_length(payload -> 'tools'),
              'toolStats', payload -> 'toolStats'
            )) else payload end`
      : sql`payload`;
  const rows = await sql<RunEventRow[]>`
    select id, run_id, seq, type, ${payload} as payload, created_at from run_events
    where run_id = ${runId} and seq > ${afterSeq}
      and ${types === undefined ? sql`true` : sql`type = any(${types}::text[])`}
    order by seq
    limit ${limit}`;
  return rows.map(mapRunEvent);
}

/** What a run used, read from its recorded tool calls (`listRunSources`). */
export interface RunSources {
  /** The pages its tools declared they read (`tool_result.source`), in order, each once. */
  pages: { url: string; title?: string }[];
  /** The tools it called that answered without an error, in order, each once (exact names). */
  tools: string[];
}

/**
 * The sources of each run: the pages its tools declared (`web_read` declares the page it read) and
 * the tools that worked. Structured fields of the log only (`tool_call.name`, `tool_result.source`,
 * `isError`): no text is read. Runs with no tool calls are absent from the map.
 */
export async function listRunSources(
  db: Db,
  runIds: readonly string[],
): Promise<Map<string, RunSources>> {
  const ids = z.array(z.uuid()).parse([...runIds]);
  const out = new Map<string, RunSources>();
  if (ids.length === 0) return out;
  const rows = await db.sql<
    {
      run_id: string;
      type: string;
      call_id: string | null;
      name: string | null;
      is_error: boolean | null;
      source: unknown;
    }[]
  >`
    select run_id, type, payload->>'callId' as call_id, payload->>'name' as name,
      (payload->>'isError')::boolean as is_error, payload->'source' as source
    from run_events
    where run_id = any(${ids}::uuid[]) and type in ('tool_call', 'tool_result')
    order by run_id, seq`;
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.call_id === null) continue;
    const key = `${row.run_id}\u0000${row.call_id}`;
    if (row.type === "tool_call") {
      if (row.name !== null) names.set(key, row.name);
      continue;
    }
    if (row.is_error !== false) continue;
    let entry = out.get(row.run_id);
    if (entry === undefined) {
      entry = { pages: [], tools: [] };
      out.set(row.run_id, entry);
    }
    const name = names.get(key);
    if (name !== undefined && !entry.tools.includes(name)) entry.tools.push(name);
    const source = pageOf(row.source);
    if (source !== undefined && !entry.pages.some((p) => p.url === source.url)) {
      entry.pages.push(source);
    }
  }
  return out;
}

function pageOf(raw: unknown): { url: string; title?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { url, title } = raw as { url?: unknown; title?: unknown };
  if (typeof url !== "string" || url === "") return undefined;
  return typeof title === "string" && title !== "" ? { url, title } : { url };
}
