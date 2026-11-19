import { z } from "zod";
import type { Db } from "./client.js";
import type { Memory, MemoryLayer, MemoryStatus } from "./memories.js";

/**
 * The queue and the record of the background consolidation (docs/MEMORIA.md). One row per
 * attempt. The window of a row is `(fromSeq, toSeq]`: the messages of the conversation after the
 * last CONCLUDED consolidation, up to the moment a worker took the row.
 *
 * Why it is safe to run in several workers, and to crash:
 * - taking a row is an INSERT (or an UPDATE of a `queued` one) guarded by a unique index that
 *   allows one live (`queued` or `running`) row per conversation, so two workers can never
 *   consolidate the same conversation at once;
 * - the cursor is the `toSeq` of the last `done` row, so a crash (the row never reaches `done`)
 *   leaves the cursor where it was and the window is simply tried again;
 * - a worker that lost its lease writes nothing (`finishConsolidation` checks the owner).
 */

export const CONSOLIDATION_REASONS = ["idle", "max_turns", "pre_compaction"] as const;
export type ConsolidationReason = (typeof CONSOLIDATION_REASONS)[number];
export const CONSOLIDATION_STATUSES = ["queued", "running", "done", "skipped", "failed"] as const;
export type ConsolidationStatus = (typeof CONSOLIDATION_STATUSES)[number];

/** After a failed attempt the conversation is left alone for this long (no retry storm). */
export const CONSOLIDATION_RETRY_AFTER_MS = 10 * 60_000;

export interface ConsolidationRecord {
  /** What the model proposed, as it said it. */
  proposed: unknown;
  /** What was written (memory ids and what happened to each). */
  kept: unknown;
  /** What the code refused, and why. */
  dropped: unknown;
}

export interface Consolidation {
  id: string;
  conversationId: string;
  botId: string;
  reason: ConsolidationReason;
  status: ConsolidationStatus;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  fromSeq: number | null;
  toSeq: number | null;
  userTurns: number | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  proposed: unknown;
  kept: unknown;
  dropped: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface Row {
  id: string;
  conversation_id: string;
  bot_id: string;
  reason: ConsolidationReason;
  status: ConsolidationStatus;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  from_seq: string | null;
  to_seq: string | null;
  user_turns: number | null;
  model: string | null;
  prompt_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  proposed: unknown;
  kept: unknown;
  dropped: unknown;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function map(r: Row): Consolidation {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    botId: r.bot_id,
    reason: r.reason,
    status: r.status,
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at,
    fromSeq: num(r.from_seq),
    toSeq: num(r.to_seq),
    userTurns: r.user_turns,
    model: r.model,
    promptVersion: r.prompt_version,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    proposed: r.proposed,
    kept: r.kept,
    dropped: r.dropped,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const uuid = z.uuid();

/**
 * Asks for a consolidation of the conversation (the pre-compaction one). It only queues: a worker
 * takes it later, so the run that asked never waits. `null` when one is already queued or running
 * for the conversation (that one will cover it).
 */
export async function requestConsolidation(
  db: Db,
  input: { conversationId: string; botId: string; reason: ConsolidationReason },
): Promise<Consolidation | null> {
  const [row] = await db.sql<Row[]>`
    insert into memory_consolidations (conversation_id, bot_id, reason, status)
    values (${uuid.parse(input.conversationId)}, ${uuid.parse(input.botId)}, ${input.reason}, 'queued')
    on conflict (conversation_id) where status in ('queued', 'running') do nothing
    returning *`;
  return row ? map(row) : null;
}

export interface ClaimOptions {
  workerId: string;
  /** How long the worker owns the row without finishing it. */
  leaseMs: number;
  idleMinutes: number;
  maxTurns: number;
  now?: Date;
}

/** The last seq a concluded consolidation covered (0 when none did). */
async function cursorOf(db: Db, conversationId: string): Promise<number> {
  const [row] = await db.sql<{ cur: string | null }[]>`
    select max(to_seq) as cur from memory_consolidations
    where conversation_id = ${conversationId} and status = 'done'`;
  return Number(row?.cur ?? 0);
}

/**
 * Takes the next consolidation to do, or `null`:
 *
 * 1. first, rows whose owner stopped (the lease ran out) are marked `failed`;
 * 2. a `queued` row (asked for before a compaction) is taken, its window set to "now";
 * 3. otherwise a conversation that is DUE gets a new `running` row. Due: a direct conversation
 *    with new user messages since the cursor, and either `maxTurns` of them, or its last message is
 *    older than `idleMinutes` and no run of it is working. A conversation that failed recently is
 *    left alone for `CONSOLIDATION_RETRY_AFTER_MS`.
 */
export async function claimConsolidation(
  db: Db,
  options: ClaimOptions,
): Promise<Consolidation | null> {
  const now = options.now ?? new Date();
  const lease = new Date(now.getTime() + options.leaseMs);
  const idleBefore = new Date(now.getTime() - options.idleMinutes * 60_000);
  const retryAfter = new Date(now.getTime() - CONSOLIDATION_RETRY_AFTER_MS);
  const { sql } = db;

  await sql`
    update memory_consolidations
    set status = 'failed', error = 'a posse expirou: o worker parou antes de terminar', finished_at = ${now}
    where status = 'running' and lease_expires_at < ${now}`;

  const [queued] = await sql<Row[]>`
    update memory_consolidations c
    set status = 'running', claimed_by = ${options.workerId}, lease_expires_at = ${lease}, started_at = ${now},
        from_seq = coalesce((select max(d.to_seq) from memory_consolidations d
                             where d.conversation_id = c.conversation_id and d.status = 'done'), 0),
        to_seq = coalesce((select max(m.seq) from messages m where m.conversation_id = c.conversation_id), 0)
    where c.id = (
      select id from memory_consolidations where status = 'queued'
      order by created_at, id for update skip locked limit 1
    )
    returning c.*`;
  if (queued) return map(queued);

  const candidates = await sql<
    { conversation_id: string; bot_id: string; cur: string; turns: string }[]
  >`
    select c.id as conversation_id, mem.bot_id, k.cur, k.turns
    from conversations c
    join conversation_members mem on mem.conversation_id = c.id
    cross join lateral (
      select
        coalesce((select max(d.to_seq) from memory_consolidations d
                  where d.conversation_id = c.id and d.status = 'done'), 0) as cur,
        (select count(*) from messages m
          where m.conversation_id = c.id and m.author_kind = 'user'
            and m.seq > coalesce((select max(d.to_seq) from memory_consolidations d
                                  where d.conversation_id = c.id and d.status = 'done'), 0)) as turns,
        (select max(m.created_at) from messages m where m.conversation_id = c.id) as last_at
    ) k
    where c.kind = 'direct' and c.archived_at is null
      and k.turns >= 1
      and (
        k.turns >= ${options.maxTurns}
        or (
          k.last_at < ${idleBefore}
          and not exists (
            select 1 from runs r
            where r.conversation_id = c.id and r.status in ('queued', 'running')
          )
        )
      )
      and not exists (
        select 1 from memory_consolidations f
        where f.conversation_id = c.id and f.status = 'failed' and f.created_at > ${retryAfter}
      )
      and not exists (
        select 1 from memory_consolidations l
        where l.conversation_id = c.id and l.status in ('queued', 'running')
      )
    order by k.last_at
    limit 5`;
  for (const cand of candidates) {
    const turns = Number(cand.turns);
    const reason: ConsolidationReason = turns >= options.maxTurns ? "max_turns" : "idle";
    const [row] = await sql<Row[]>`
      insert into memory_consolidations (
        conversation_id, bot_id, reason, status, claimed_by, lease_expires_at, started_at,
        from_seq, to_seq
      )
      select ${cand.conversation_id}, ${cand.bot_id}, ${reason}, 'running', ${options.workerId},
        ${lease}, ${now}, ${Number(cand.cur)},
        coalesce((select max(m.seq) from messages m where m.conversation_id = ${cand.conversation_id}), 0)
      on conflict (conversation_id) where status in ('queued', 'running') do nothing
      returning *`;
    if (row) return map(row);
  }
  return null;
}

/** A message of the window, as the consolidation reads it: only what a person and the bot said. */
export interface WindowMessage {
  id: string;
  seq: number;
  author: "user" | "bot";
  text: string;
}

/**
 * The messages of the window `(fromSeq, toSeq]`: the user's messages and the bot's messages in
 * the chat (its final answers and questions). System notices are left out. Nothing else of a run
 * is ever read here: no tool call, no tool result, no reasoning, no journal.
 */
export async function consolidationWindow(
  db: Db,
  input: { conversationId: string; fromSeq: number; toSeq: number },
): Promise<WindowMessage[]> {
  const rows = await db.sql<
    { id: string; seq: string; author_kind: "user" | "bot"; text: string }[]
  >`
    select id, seq, author_kind, text from messages
    where conversation_id = ${uuid.parse(input.conversationId)}
      and seq > ${input.fromSeq} and seq <= ${input.toSeq}
      and author_kind in ('user', 'bot')
    order by seq`;
  return rows.map((r) => ({ id: r.id, seq: Number(r.seq), author: r.author_kind, text: r.text }));
}

export interface VisibleMemory {
  id: string;
  layer: MemoryLayer;
  status: MemoryStatus;
  text: string;
  summary: string | null;
  sourceConversationId: string | null;
}

/**
 * The memories of this bot the consolidation may compare against: its rules (shared and own), the
 * shared profile and its notes, active or pending, newest last, at most `limit`. No journal.
 */
export async function memoriesVisibleTo(
  db: Db,
  botId: string,
  limit = 200,
): Promise<VisibleMemory[]> {
  const rows = await db.sql<
    {
      id: string;
      layer: MemoryLayer;
      status: MemoryStatus;
      text: string;
      summary: string | null;
      source_conversation_id: string | null;
    }[]
  >`
    select id, layer, status, text, summary, source_conversation_id from (
      select * from memories
      where archived_at is null and status in ('active', 'pending')
        and layer in ('rule', 'profile', 'note')
        and (scope = 'shared' or bot_id = ${uuid.parse(botId)})
      order by created_at desc, id desc limit ${limit}
    ) recent order by created_at, id`;
  return rows.map((r) => ({
    id: r.id,
    layer: r.layer,
    status: r.status,
    text: r.text,
    summary: r.summary,
    sourceConversationId: r.source_conversation_id,
  }));
}

export interface FinishConsolidationInput {
  id: string;
  workerId: string;
  status: "done" | "skipped" | "failed";
  userTurns?: number;
  model?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  record?: ConsolidationRecord;
  error?: string;
}

/**
 * Locks the row for its owner: `true` while the worker still owns a `running` row. Call it inside
 * the transaction that writes the memories; a worker that lost the row (its lease ran out and
 * another worker took over) gets `false` and must write nothing.
 */
export async function lockOwnConsolidation(db: Db, id: string, workerId: string): Promise<boolean> {
  const [row] = await db.sql<{ id: string }[]>`
    select id from memory_consolidations
    where id = ${uuid.parse(id)} and status = 'running' and claimed_by = ${workerId}
    for update`;
  return row !== undefined;
}

/** Closes the row. Only the owner of a `running` row can; returns whether it did. */
export async function finishConsolidation(
  db: Db,
  input: FinishConsolidationInput,
): Promise<boolean> {
  const { sql } = db;
  const rows = await sql<{ id: string }[]>`
    update memory_consolidations set
      status = ${input.status},
      user_turns = ${input.userTurns ?? null},
      model = ${input.model ?? null},
      prompt_version = ${input.promptVersion ?? null},
      input_tokens = ${input.inputTokens ?? null},
      output_tokens = ${input.outputTokens ?? null},
      cost_usd = ${input.costUsd ?? null},
      latency_ms = ${input.latencyMs ?? null},
      proposed = ${input.record === undefined ? null : sql.json(input.record.proposed as never)},
      kept = ${input.record === undefined ? null : sql.json(input.record.kept as never)},
      dropped = ${input.record === undefined ? null : sql.json(input.record.dropped as never)},
      error = ${input.error ?? null},
      lease_expires_at = null,
      finished_at = now()
    where id = ${uuid.parse(input.id)} and status = 'running' and claimed_by = ${input.workerId}
    returning id`;
  return rows.length === 1;
}

export async function getConsolidation(db: Db, id: string): Promise<Consolidation | null> {
  const [row] = await db.sql<
    Row[]
  >`select * from memory_consolidations where id = ${uuid.parse(id)}`;
  return row ? map(row) : null;
}

export async function listConsolidations(
  db: Db,
  options: { conversationId?: string; limit?: number } = {},
): Promise<Consolidation[]> {
  const rows = await db.sql<Row[]>`
    select * from memory_consolidations
    where ${options.conversationId === undefined ? db.sql`true` : db.sql`conversation_id = ${uuid.parse(options.conversationId)}`}
    order by created_at desc, id desc limit ${options.limit ?? 50}`;
  return rows.map(map);
}

/** The last seq a concluded consolidation of this conversation covered. */
export async function consolidationCursor(db: Db, conversationId: string): Promise<number> {
  return cursorOf(db, uuid.parse(conversationId));
}

export interface MemoryReviewInput {
  runId: string;
  botId: string;
  memoryId: string | null;
  layer: string;
  decision: "run" | "ask" | "block" | "error";
  reason: string;
  outcome: "active" | "pending" | "not_saved";
  model?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

/** Records the review of a write the bot made after its run read content from outside. */
export async function recordMemoryReview(db: Db, input: MemoryReviewInput): Promise<void> {
  await db.sql`
    insert into memory_reviews (
      run_id, bot_id, memory_id, layer, decision, reason, outcome,
      model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms
    ) values (
      ${input.runId}, ${input.botId}, ${input.memoryId}, ${input.layer}, ${input.decision},
      ${input.reason}, ${input.outcome}, ${input.model ?? null}, ${input.promptVersion ?? null},
      ${input.inputTokens ?? null}, ${input.outputTokens ?? null}, ${input.costUsd ?? null},
      ${input.latencyMs ?? null}
    )`;
}

export interface MemoryReviewRow {
  id: string;
  runId: string;
  memoryId: string | null;
  layer: string;
  decision: string;
  reason: string;
  outcome: string;
  model: string | null;
  createdAt: Date;
}

export async function listMemoryReviews(db: Db, runId: string): Promise<MemoryReviewRow[]> {
  const rows = await db.sql<
    {
      id: string;
      run_id: string;
      memory_id: string | null;
      layer: string;
      decision: string;
      reason: string;
      outcome: string;
      model: string | null;
      created_at: Date;
    }[]
  >`select * from memory_reviews where run_id = ${uuid.parse(runId)} order by created_at, id`;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    memoryId: r.memory_id,
    layer: r.layer,
    decision: r.decision,
    reason: r.reason,
    outcome: r.outcome,
    model: r.model,
    createdAt: r.created_at,
  }));
}

export type { Memory };

/** The latest review of each of these memories (a write the bot made after reading outside content). */
export async function latestMemoryReviews(
  db: Db,
  memoryIds: readonly string[],
): Promise<Map<string, { decision: string; reason: string }>> {
  if (memoryIds.length === 0) return new Map();
  const ids = z.array(uuid).parse([...memoryIds]);
  const rows = await db.sql<{ memory_id: string; decision: string; reason: string }[]>`
    select distinct on (memory_id) memory_id, decision, reason from memory_reviews
    where memory_id = any(${ids}::uuid[])
    order by memory_id, created_at desc, id desc`;
  return new Map(rows.map((r) => [r.memory_id, { decision: r.decision, reason: r.reason }]));
}
