import { LeaseLostError } from "@suup/core";
import { z } from "zod";
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
  const body = eventPayloadSchema.parse(payload);
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
   * (`omitted: true`, `provider`, `model`, `purpose`, `messageCount`, `toolCount`). The database
   * does the cutting, so the megabytes never leave it.
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
              'toolCount', jsonb_array_length(payload -> 'tools')
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
