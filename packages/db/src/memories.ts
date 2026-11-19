import type { Fragment } from "postgres";
import { z } from "zod";
import type { Db } from "./client.js";
import { withTransaction } from "./client.js";
import { MEMORY_PROMPT_CEILING_CHARS } from "./memory-settings.js";
import { SEARCH_HEADLINE_OPTIONS, searchQuerySchema } from "./messages.js";

export const MEMORY_LAYERS = ["rule", "profile", "note", "journal"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export const MEMORY_SCOPES = ["shared", "bot"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_CREATORS = ["user", "bot"] as const;
export type MemoryCreator = (typeof MEMORY_CREATORS)[number];
/**
 * `active` counts; `pending` waits for the user (a rule or a profile fact proposed by a bot or by
 * the consolidation: it never enters a prompt); `rejected` was refused by the user and stays so the
 * consolidation does not propose the same thing again.
 */
export const MEMORY_STATUSES = ["active", "pending", "rejected"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
/** Who changed a memory (the history of changes keeps it). */
export const REVISION_ACTORS = ["user", "bot", "consolidation", "expiry"] as const;
export type RevisionActor = (typeof REVISION_ACTORS)[number];
export const REVISION_KINDS = [
  "created",
  "edited",
  "confirmed",
  "rejected",
  "archived",
  "restored",
  "promoted",
  "undone",
] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
/** The longest short fact (`summary`) of a note or a journal entry. */
export const MAX_SUMMARY_CHARS = 200;

/** Where a change came from: kept with the change, so the user can see it. */
export interface MemoryOrigin {
  runId?: string;
  conversationId?: string;
  messageId?: string;
  consolidationId?: string;
}

export interface Memory {
  id: string;
  layer: MemoryLayer;
  scope: MemoryScope;
  /** Set exactly when `scope` is `"bot"`. */
  botId: string | null;
  text: string;
  sourceConversationId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  createdBy: MemoryCreator;
  status: MemoryStatus;
  /** A pending memory that proposes to replace this one: confirming it archives the other. */
  supersedesId: string | null;
  /** The short fact (at most 200 characters) of a note or a journal entry; searched with the text. */
  summary: string | null;
  /** The last time `recall` found it (or null). Notes and the journal expire when unused. */
  lastUsedAt: Date | null;
  /** Whether the vector of the current text exists (the vector itself arrives with embeddings). */
  embeddingReady: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Forgotten memories are archived, not deleted: they can be restored and audited. */
  archivedAt: Date | null;
}

interface MemoryRow {
  id: string;
  layer: MemoryLayer;
  scope: MemoryScope;
  bot_id: string | null;
  text: string;
  source_conversation_id: string | null;
  source_run_id: string | null;
  source_message_id: string | null;
  created_by: MemoryCreator;
  status: MemoryStatus;
  supersedes_id: string | null;
  summary: string | null;
  last_used_at: Date | null;
  embedding_ready: boolean;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    layer: row.layer,
    scope: row.scope,
    botId: row.bot_id,
    text: row.text,
    sourceConversationId: row.source_conversation_id,
    sourceRunId: row.source_run_id,
    sourceMessageId: row.source_message_id,
    createdBy: row.created_by,
    status: row.status,
    supersedesId: row.supersedes_id,
    summary: row.summary,
    lastUsedAt: row.last_used_at,
    embeddingReady: row.embedding_ready,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

// Explicit columns: `select *` would also ship the `search` tsvector.
const MEMORY_COLUMNS = [
  "id",
  "layer",
  "scope",
  "bot_id",
  "text",
  "source_conversation_id",
  "source_run_id",
  "source_message_id",
  "created_by",
  "status",
  "supersedes_id",
  "summary",
  "last_used_at",
  "embedding_ready",
  "created_at",
  "updated_at",
  "archived_at",
];

const uuidSchema = z.uuid();
const layerSchema = z.enum(MEMORY_LAYERS);
const scopeSchema = z.enum(MEMORY_SCOPES);
const statusSchema = z.enum(MEMORY_STATUSES);
const actorSchema = z.enum(REVISION_ACTORS);
const textSchema = z.string().refine((t) => t.trim().length > 0, "text must not be blank");
const summarySchema = z
  .string()
  .transform((t) => t.trim())
  .refine((t) => t.length >= 1 && t.length <= MAX_SUMMARY_CHARS, {
    message: `summary must have 1 to ${MAX_SUMMARY_CHARS} characters`,
  });
const limitSchema = z.number().int().positive();

export interface AddMemoryInput {
  layer: MemoryLayer;
  /**
   * Defaults by layer: `profile` is shared, `note` and `journal` are per bot, and a `rule` is
   * per bot when `botId` is given and shared otherwise.
   */
  scope?: MemoryScope;
  /** Required for scope `bot`, not allowed for `shared`. */
  botId?: string;
  text: string;
  /** The short fact, at most 200 characters (searched together with the text). */
  summary?: string;
  sourceConversationId?: string;
  sourceRunId?: string;
  sourceMessageId?: string;
  createdBy: MemoryCreator;
  /** Default `active`. A rule or profile fact that a bot proposed is saved `pending`. */
  status?: "active" | "pending";
  /** Who is saving it, for the history. Default: `user` for `createdBy: "user"`, else `bot`. */
  actor?: RevisionActor;
  /** The consolidation that proposed it (kept in the history). */
  consolidationId?: string;
  /** Only for a pending memory: the memory it proposes to replace (confirming archives that one). */
  supersedesId?: string;
}

const addSchema = z
  .object({
    layer: layerSchema,
    scope: z.exactOptional(scopeSchema),
    botId: z.exactOptional(uuidSchema),
    text: textSchema,
    summary: z.exactOptional(summarySchema),
    sourceConversationId: z.exactOptional(uuidSchema),
    sourceRunId: z.exactOptional(uuidSchema),
    sourceMessageId: z.exactOptional(uuidSchema),
    createdBy: z.enum(MEMORY_CREATORS),
    status: z.exactOptional(z.enum(["active", "pending"])),
    actor: z.exactOptional(actorSchema),
    consolidationId: z.exactOptional(uuidSchema),
    supersedesId: z.exactOptional(uuidSchema),
  })
  .transform((m, ctx) => {
    const scope: MemoryScope =
      m.scope ??
      (m.layer === "profile"
        ? "shared"
        : m.layer === "rule"
          ? m.botId !== undefined
            ? "bot"
            : "shared"
          : "bot");
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (m.layer === "profile" && scope !== "shared") fail("scope", "profile memories are shared");
    if ((m.layer === "note" || m.layer === "journal") && scope !== "bot") {
      fail("scope", `${m.layer} memories belong to one bot`);
    }
    if ((scope === "bot") !== (m.botId !== undefined)) {
      fail("botId", "botId is required when scope is 'bot', and not allowed otherwise");
    }
    if (m.status === "pending" && m.layer === "journal") {
      fail("status", "a journal entry cannot wait for confirmation");
    }
    return { ...m, scope };
  });

/**
 * The columns of a revision, written in the SAME statement as the change it records (a CTE), so a
 * memory never changes without its history and a failed change never leaves one.
 */
function revisionColumns(
  sql: Db["sql"],
  kind: RevisionKind,
  actor: RevisionActor,
  origin: MemoryOrigin | undefined,
) {
  return sql`
    insert into memory_revisions (
      memory_id, kind, actor,
      prev_text, prev_summary, prev_status, prev_layer, prev_scope, prev_bot_id, prev_archived,
      new_text, new_summary, new_status, new_layer, new_scope, new_bot_id, new_archived,
      origin_run_id, origin_conversation_id, origin_message_id, origin_consolidation_id
    )
    select
      upd.id, ${kind}, ${actor},
      old.text, old.summary, old.status, old.layer, old.scope, old.bot_id, old.archived_at is not null,
      upd.text, upd.summary, upd.status, upd.layer, upd.scope, upd.bot_id, upd.archived_at is not null,
      ${origin?.runId ?? null}, ${origin?.conversationId ?? null}, ${origin?.messageId ?? null},
      ${origin?.consolidationId ?? null}
    from old, upd`;
}

interface ChangeOptions {
  kind: RevisionKind;
  actor: RevisionActor;
  origin?: MemoryOrigin | undefined;
}

/**
 * Applies `set` to one memory and records the revision, in one statement. `guard` (extra `where`)
 * makes a no-op change write nothing: the memory comes back as it is.
 */
async function applyChange(
  db: Db,
  id: string,
  set: Fragment,
  guard: Fragment,
  options: ChangeOptions,
): Promise<Memory | null> {
  const { sql } = db;
  const memoryId = uuidSchema.parse(id);
  const rows = await sql<MemoryRow[]>`
    with old as (select * from memories where id = ${memoryId}),
    upd as (
      update memories set ${set}
      where id = ${memoryId} and ${guard}
      returning *
    ),
    rev as (${revisionColumns(sql, options.kind, actorSchema.parse(options.actor), options.origin)})
    select ${sql(MEMORY_COLUMNS.map((c) => `upd.${c}`))} from upd`;
  const [row] = rows;
  if (row !== undefined) return mapMemory(row);
  return getMemory(db, memoryId);
}

/** Saves a memory. The layer/scope rules are checked here (clear errors) and by the database. */
export async function addMemory(db: Db, input: AddMemoryInput): Promise<Memory> {
  const m = addSchema.parse(input);
  const actor: RevisionActor = m.actor ?? (m.createdBy === "user" ? "user" : "bot");
  const { sql } = db;
  const [row] = await sql<MemoryRow[]>`
    with ins as (
      insert into memories (
        layer, scope, bot_id, text, summary, status, supersedes_id,
        source_conversation_id, source_run_id, source_message_id, created_by
      )
      values (
        ${m.layer}, ${m.scope}, ${m.botId ?? null}, ${m.text}, ${m.summary ?? null},
        ${m.status ?? "active"}, ${m.supersedesId ?? null},
        ${m.sourceConversationId ?? null}, ${m.sourceRunId ?? null}, ${m.sourceMessageId ?? null},
        ${m.createdBy}
      )
      returning *
    ),
    rev as (
      insert into memory_revisions (
        memory_id, kind, actor,
        new_text, new_summary, new_status, new_layer, new_scope, new_bot_id, new_archived,
        origin_run_id, origin_conversation_id, origin_message_id, origin_consolidation_id
      )
      select
        id, 'created', ${actor},
        text, summary, status, layer, scope, bot_id, false,
        ${m.sourceRunId ?? null}, ${m.sourceConversationId ?? null}, ${m.sourceMessageId ?? null},
        ${m.consolidationId ?? null}
      from ins
    )
    select ${sql(MEMORY_COLUMNS)} from ins`;
  if (!row) throw new Error("insert into memories returned no row");
  return mapMemory(row);
}

export interface AddJournalInput {
  botId: string;
  text: string;
  /** The short fact of the entry, written by the journal writer from its own fields. */
  summary?: string;
  /** The run the entry is about. It is the idempotency key: one entry per run. */
  sourceRunId: string;
  sourceConversationId?: string;
}

/**
 * Writes the journal entry of a finished run, once: the run is the key (a unique index), so a
 * second call for the same run (a resume, a redelivery, another worker) changes nothing and
 * returns `null`. The entry belongs to the bot and is marked as written by the bot.
 */
export async function addJournalMemory(db: Db, input: AddJournalInput): Promise<Memory | null> {
  const botId = uuidSchema.parse(input.botId);
  const runId = uuidSchema.parse(input.sourceRunId);
  const conversationId =
    input.sourceConversationId === undefined ? null : uuidSchema.parse(input.sourceConversationId);
  const summary = input.summary === undefined ? null : summarySchema.parse(input.summary);
  const { sql } = db;
  const [row] = await sql<MemoryRow[]>`
    with ins as (
      insert into memories (layer, scope, bot_id, text, summary, source_conversation_id, source_run_id, created_by)
      values ('journal', 'bot', ${botId}, ${textSchema.parse(input.text)}, ${summary}, ${conversationId}, ${runId}, 'bot')
      on conflict (source_run_id) where layer = 'journal' and source_run_id is not null do nothing
      returning *
    ),
    rev as (
      insert into memory_revisions (
        memory_id, kind, actor,
        new_text, new_summary, new_status, new_layer, new_scope, new_bot_id, new_archived,
        origin_run_id, origin_conversation_id
      )
      select id, 'created', 'bot', text, summary, status, layer, scope, bot_id, false,
        source_run_id, source_conversation_id
      from ins
    )
    select ${sql(MEMORY_COLUMNS)} from ins`;
  return row ? mapMemory(row) : null;
}

export async function getMemory(db: Db, id: string): Promise<Memory | null> {
  const [row] = await db.sql<MemoryRow[]>`
    select ${db.sql(MEMORY_COLUMNS)} from memories where id = ${uuidSchema.parse(id)}`;
  return row ? mapMemory(row) : null;
}

export interface MemoryChangeInput {
  /** Who is changing it. Default `user`. */
  actor?: RevisionActor;
  origin?: MemoryOrigin;
}

/**
 * Corrects the text of a memory (and, when given, its short fact; `summary: null` clears it).
 * Layer, scope and origin are fixed. Bumps `updated_at` and clears `embedding_ready`, since the
 * vector of the old text is stale. Changing nothing writes nothing. Returns `null` if the memory
 * does not exist.
 */
export async function updateMemory(
  db: Db,
  id: string,
  text: string,
  options: MemoryChangeInput & { summary?: string | null } = {},
): Promise<Memory | null> {
  const { sql } = db;
  const summary =
    options.summary === undefined
      ? undefined
      : options.summary === null
        ? null
        : summarySchema.parse(options.summary);
  const next = textSchema.parse(text);
  return applyChange(
    db,
    id,
    sql`text = ${next}, ${summary === undefined ? sql`summary = summary` : sql`summary = ${summary}`}, embedding_ready = false`,
    sql`(text is distinct from ${next} ${summary === undefined ? sql`` : sql`or summary is distinct from ${summary}`})`,
    { kind: "edited", actor: options.actor ?? "user", origin: options.origin },
  );
}

/** Forgets a memory (soft). Idempotent: archiving twice keeps the first `archivedAt`. */
export async function archiveMemory(
  db: Db,
  id: string,
  options: MemoryChangeInput = {},
): Promise<Memory | null> {
  const { sql } = db;
  return applyChange(db, id, sql`archived_at = now()`, sql`archived_at is null`, {
    kind: "archived",
    actor: options.actor ?? "user",
    origin: options.origin,
  });
}

/** Undoes `archiveMemory`. Idempotent. */
export async function restoreMemory(
  db: Db,
  id: string,
  options: MemoryChangeInput = {},
): Promise<Memory | null> {
  const { sql } = db;
  return applyChange(db, id, sql`archived_at = null`, sql`archived_at is not null`, {
    kind: "restored",
    actor: options.actor ?? "user",
    origin: options.origin,
  });
}

/**
 * The user confirms a pending memory: it becomes active (and enters the prompts from the next run).
 * Only a pending memory changes; anything else comes back as it is.
 */
export async function confirmMemory(
  db: Db,
  id: string,
  options: MemoryChangeInput = {},
): Promise<Memory | null> {
  const confirm = async (tx: Db) => {
    const memory = await applyChange(
      tx,
      id,
      tx.sql`status = 'active'`,
      tx.sql`status = 'pending'`,
      {
        kind: "confirmed",
        actor: options.actor ?? "user",
        origin: options.origin,
      },
    );
    // A pending memory that proposed to replace another one: confirming it archives the old one.
    if (memory?.status === "active" && memory.supersedesId !== null) {
      await archiveMemory(tx, memory.supersedesId, {
        actor: options.actor ?? "user",
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    }
    return memory;
  };
  return withTransaction(db, confirm);
}

/** The user refuses a pending memory. It is kept as `rejected` so it is not proposed again. */
export async function rejectMemory(
  db: Db,
  id: string,
  options: MemoryChangeInput = {},
): Promise<Memory | null> {
  const { sql } = db;
  return applyChange(db, id, sql`status = 'rejected'`, sql`status = 'pending'`, {
    kind: "rejected",
    actor: options.actor ?? "user",
    origin: options.origin,
  });
}

/**
 * A note becomes a shared profile fact (active): the same fact was proposed from two different
 * conversations. The history keeps the old layer, scope and bot, so it can be undone. Only a note
 * or a pending profile fact can be promoted; anything else comes back as it is.
 */
export async function promoteToProfile(
  db: Db,
  id: string,
  options: MemoryChangeInput = {},
): Promise<Memory | null> {
  const { sql } = db;
  return applyChange(
    db,
    id,
    sql`layer = 'profile', scope = 'shared', bot_id = null, status = 'active'`,
    sql`archived_at is null and ((layer = 'note' and status = 'active') or (layer = 'profile' and status = 'pending'))`,
    { kind: "promoted", actor: options.actor ?? "consolidation", origin: options.origin },
  );
}

/** Renews `last_used_at` of memories that `recall` just found. Not an edit: nothing else changes. */
export async function touchMemories(
  db: Db,
  ids: readonly string[],
  now = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  const list = z.array(uuidSchema).parse([...ids]);
  await db.sql`update memories set last_used_at = ${now} where id = any(${list}::uuid[])`;
}

/**
 * Archives the notes and journal entries nobody used for `days` days (last use, or creation when
 * never used). Rules and the profile never expire. Archiving is the usual "forget": restorable, and
 * each one is in the history as done by `expiry`. Returns the memories archived.
 */
export async function expireUnusedMemories(
  db: Db,
  options: { days: number; now?: Date },
): Promise<Memory[]> {
  const days = z.number().int().positive().parse(options.days);
  const cutoff = new Date((options.now ?? new Date()).getTime() - days * 86_400_000);
  const { sql } = db;
  const rows = await sql<MemoryRow[]>`
    with old as (
      select * from memories
      where archived_at is null and status = 'active' and layer in ('note', 'journal')
        and coalesce(last_used_at, created_at) < ${cutoff}
      for update skip locked
    ),
    upd as (
      update memories set archived_at = ${options.now ?? new Date()}
      where id in (select id from old)
      returning *
    ),
    rev as (${revisionColumns(sql, "archived", "expiry", undefined)})
    select ${sql(MEMORY_COLUMNS.map((c) => `upd.${c}`))} from upd`;
  return rows.map(mapMemory);
}

export interface ListMemoriesOptions {
  layer?: MemoryLayer;
  scope?: MemoryScope;
  /** Only memories that belong to this bot (its own `bot`-scoped ones). */
  botId?: string;
  includeArchived?: boolean;
  /** Default `active`: a pending or rejected memory is not part of the memory until asked for. */
  status?: MemoryStatus;
  limit: number;
}

/**
 * The management view (what the user sees on the memory screen): plain filters, no per-bot
 * visibility rule. Oldest first (`created_at`, `id`). Archived ones only with `includeArchived`;
 * pending ones only with `status: "pending"`.
 */
export async function listMemories(db: Db, opts: ListMemoriesOptions): Promise<Memory[]> {
  const { sql } = db;
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where ${opts.includeArchived ? sql`true` : sql`archived_at is null`}
      and status = ${statusSchema.parse(opts.status ?? "active")}
      and ${opts.layer !== undefined ? sql`layer = ${layerSchema.parse(opts.layer)}` : sql`true`}
      and ${opts.scope !== undefined ? sql`scope = ${scopeSchema.parse(opts.scope)}` : sql`true`}
      and ${opts.botId !== undefined ? sql`bot_id = ${uuidSchema.parse(opts.botId)}` : sql`true`}
    order by created_at, id
    limit ${limitSchema.parse(opts.limit)}`;
  return rows.map(mapMemory);
}

/**
 * The memories (not archived, any status) whose text is EXACTLY this one once case and runs of
 * white space are ignored (`suup_text_key`). Comparison by equality: nothing fuzzy.
 */
export async function findMemoriesWithText(
  db: Db,
  text: string,
  filter: { layers?: MemoryLayer[]; botId?: string } = {},
): Promise<Memory[]> {
  const { sql } = db;
  const layers =
    filter.layers === undefined ? undefined : z.array(layerSchema).parse(filter.layers);
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where text_key = suup_text_key(${textSchema.parse(text)})
      and archived_at is null
      and ${layers === undefined ? sql`true` : sql`layer = any(${layers}::text[])`}
      and ${filter.botId === undefined ? sql`true` : sql`(scope = 'shared' or bot_id = ${uuidSchema.parse(filter.botId)})`}
    order by created_at, id`;
  return rows.map(mapMemory);
}

/**
 * The memories (not archived, any status) whose short fact (`summary`) is EXACTLY this one once
 * case and runs of white space are ignored. Same comparison as `findMemoriesWithText`: equality only.
 * Visible to `botId` (shared + its own) when given.
 */
export async function findMemoriesWithSummary(
  db: Db,
  summary: string,
  filter: { layers?: MemoryLayer[]; botId?: string } = {},
): Promise<Memory[]> {
  const { sql } = db;
  const layers =
    filter.layers === undefined ? undefined : z.array(layerSchema).parse(filter.layers);
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where summary is not null
      and suup_text_key(summary) = suup_text_key(${summarySchema.parse(summary)})
      and archived_at is null
      and status <> 'rejected'
      and ${layers === undefined ? sql`true` : sql`layer = any(${layers}::text[])`}
      and ${filter.botId === undefined ? sql`true` : sql`(scope = 'shared' or bot_id = ${uuidSchema.parse(filter.botId)})`}
    order by created_at, id`;
  return rows.map(mapMemory);
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  kind: RevisionKind;
  actor: RevisionActor;
  prev: {
    text: string;
    summary: string | null;
    status: MemoryStatus;
    layer: MemoryLayer;
    scope: MemoryScope;
    botId: string | null;
    archived: boolean;
  } | null;
  next: {
    text: string;
    summary: string | null;
    status: MemoryStatus;
    layer: MemoryLayer;
    scope: MemoryScope;
    botId: string | null;
    archived: boolean;
  };
  originRunId: string | null;
  originConversationId: string | null;
  originMessageId: string | null;
  originConsolidationId: string | null;
  createdAt: Date;
}

interface RevisionRow {
  id: string;
  memory_id: string;
  kind: RevisionKind;
  actor: RevisionActor;
  prev_text: string | null;
  prev_summary: string | null;
  prev_status: MemoryStatus | null;
  prev_layer: MemoryLayer | null;
  prev_scope: MemoryScope | null;
  prev_bot_id: string | null;
  prev_archived: boolean | null;
  new_text: string;
  new_summary: string | null;
  new_status: MemoryStatus;
  new_layer: MemoryLayer;
  new_scope: MemoryScope;
  new_bot_id: string | null;
  new_archived: boolean;
  origin_run_id: string | null;
  origin_conversation_id: string | null;
  origin_message_id: string | null;
  origin_consolidation_id: string | null;
  created_at: Date;
}

function mapRevision(r: RevisionRow): MemoryRevision {
  return {
    id: r.id,
    memoryId: r.memory_id,
    kind: r.kind,
    actor: r.actor,
    prev:
      r.prev_text === null ||
      r.prev_status === null ||
      r.prev_layer === null ||
      r.prev_scope === null ||
      r.prev_archived === null
        ? null
        : {
            text: r.prev_text,
            summary: r.prev_summary,
            status: r.prev_status,
            layer: r.prev_layer,
            scope: r.prev_scope,
            botId: r.prev_bot_id,
            archived: r.prev_archived,
          },
    next: {
      text: r.new_text,
      summary: r.new_summary,
      status: r.new_status,
      layer: r.new_layer,
      scope: r.new_scope,
      botId: r.new_bot_id,
      archived: r.new_archived,
    },
    originRunId: r.origin_run_id,
    originConversationId: r.origin_conversation_id,
    originMessageId: r.origin_message_id,
    originConsolidationId: r.origin_consolidation_id,
    createdAt: r.created_at,
  };
}

/** The history of one memory, newest first. */
export async function listMemoryRevisions(
  db: Db,
  memoryId: string,
  limit = 100,
): Promise<MemoryRevision[]> {
  const rows = await db.sql<RevisionRow[]>`
    select * from memory_revisions where memory_id = ${uuidSchema.parse(memoryId)}
    order by created_at desc, id desc limit ${limitSchema.parse(limit)}`;
  return rows.map(mapRevision);
}

export async function getMemoryRevision(db: Db, id: string): Promise<MemoryRevision | null> {
  const [row] = await db.sql<RevisionRow[]>`
    select * from memory_revisions where id = ${uuidSchema.parse(id)}`;
  return row ? mapRevision(row) : null;
}

export class RevisionError extends Error {
  override readonly name = "RevisionError";
  constructor(
    readonly code: "not_found" | "not_latest" | "nothing_to_undo",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Undoes one change: puts the memory back as it was BEFORE that revision (text, short fact, status,
 * layer, scope, forgotten or not). Only the latest revision of a memory can be undone (an older
 * one would overwrite what came after); the undo is itself a revision (`undone`), so undoing it
 * redoes the change. Undoing the creation of a memory forgets it.
 */
export async function undoMemoryRevision(
  db: Db,
  revisionId: string,
  options: MemoryChangeInput = {},
): Promise<Memory> {
  const revision = await getMemoryRevision(db, revisionId);
  if (revision === null) throw new RevisionError("not_found", "Mudança não encontrada.");
  const [latest] = await db.sql<{ id: string }[]>`
    select id from memory_revisions where memory_id = ${revision.memoryId}
    order by created_at desc, id desc limit 1`;
  if (latest?.id !== revision.id) {
    throw new RevisionError(
      "not_latest",
      "Só a mudança mais recente de uma memória pode ser desfeita: desfaça primeiro as que vieram depois.",
    );
  }
  const { sql } = db;
  const { prev } = revision;
  const set =
    prev === null
      ? sql`archived_at = coalesce(archived_at, now())`
      : sql`
          text = ${prev.text}, summary = ${prev.summary}, status = ${prev.status},
          layer = ${prev.layer}, scope = ${prev.scope}, bot_id = ${prev.botId},
          archived_at = ${prev.archived ? sql`coalesce(archived_at, now())` : null},
          embedding_ready = false`;
  const memory = await applyChange(db, revision.memoryId, set, sql`true`, {
    kind: "undone",
    actor: options.actor ?? "user",
    origin: options.origin,
  });
  if (memory === null) throw new RevisionError("not_found", "Memória não encontrada.");
  return memory;
}

export interface SearchMemoriesOptions {
  query: string;
  /**
   * The bot searching: it sees the shared memories and its own. Without it only the shared ones
   * are searched, never another bot's notes.
   */
  botId?: string;
  /** Restrict to these layers. Default: all. */
  layers?: MemoryLayer[];
  limit: number;
  /**
   * `all` (default): every word of the query must be in the memory. `any`: at least one of them
   * (the OR of the same lexemes, same ranking; see `suup_search_query_any`, migration 0018).
   */
  match?: "all" | "any";
}

export interface MemorySearchHit {
  memory: Memory;
  /** The text around the match; matched words are wrapped in `HIGHLIGHT_START`/`HIGHLIGHT_END` (see messages.ts). */
  excerpt: string;
  /** `ts_rank` score; higher is better. */
  rank: number;
}

/**
 * Full-text search (Portuguese) over the active memories VISIBLE to the bot (shared + its own),
 * best match first, then oldest. The query goes through `websearch_to_tsquery`, so any string is
 * safe; a query with no searchable terms returns `[]`.
 */
export async function searchMemories(
  db: Db,
  opts: SearchMemoriesOptions,
): Promise<MemorySearchHit[]> {
  const query = searchQuerySchema.parse(opts.query);
  const limit = limitSchema.parse(opts.limit);
  const botId = opts.botId === undefined ? undefined : uuidSchema.parse(opts.botId);
  const layers = opts.layers === undefined ? undefined : z.array(layerSchema).parse(opts.layers);
  if (layers?.length === 0) return [];
  const { sql } = db;
  const rows = await sql<(MemoryRow & { excerpt: string; rank: number })[]>`
    with q as (select ${opts.match === "any" ? sql`suup_search_query_any(${query})` : sql`suup_search_query(${query})`} as tsq)
    select ${sql(MEMORY_COLUMNS.map((c) => `m.${c}`))},
      ts_rank(m.search, q.tsq) as rank,
      ts_headline('portuguese', m.text, q.tsq, ${SEARCH_HEADLINE_OPTIONS}) as excerpt
    from memories m, q
    where numnode(q.tsq) > 0
      and m.search @@ q.tsq
      and m.archived_at is null
      and m.status = 'active'
      and (m.scope = 'shared' ${botId !== undefined ? sql`or m.bot_id = ${botId}` : sql``})
      and ${layers !== undefined ? sql`m.layer = any(${layers}::text[])` : sql`true`}
    order by rank desc, m.created_at, m.id
    limit ${limit}`;
  return rows.map((r) => ({ memory: mapMemory(r), excerpt: r.excerpt, rank: Number(r.rank) }));
}

/**
 * The search the bot uses: every word of the query; and only when that finds nothing, any of its
 * words (`broader: true`, so the caller can say so). A result with hits is never broadened.
 */
export async function searchMemoriesBroadening(
  db: Db,
  opts: Omit<SearchMemoriesOptions, "match">,
): Promise<{ hits: MemorySearchHit[]; broader: boolean }> {
  const strict = await searchMemories(db, { ...opts, match: "all" });
  if (strict.length > 0) return { hits: strict, broader: false };
  const hits = await searchMemories(db, { ...opts, match: "any" });
  return { hits, broader: hits.length > 0 };
}

export interface MemoryContext {
  /** Standing orders: the shared rules and this bot's own, oldest first. */
  rules: Memory[];
  /** The shared profile, oldest first. */
  profile: Memory[];
  /** What did not fit under the size cap (nothing is cut silently: it is counted here). */
  omitted: { count: number; chars: number };
  /** Characters of every active rule and profile fact this bot would load without a cap. */
  totalChars: number;
}

/**
 * Everything that goes into every run of this bot: the shared rules, the bot's own rules and the
 * shared profile (ACTIVE ones only: a pending memory never enters a prompt). Ordered by
 * (`created_at`, `id`), so the text built from it stays byte-identical until a memory changes,
 * which keeps the prompt prefix cacheable.
 *
 * With `limitItems` the rules and profile facts together are taken in creation order while there
 * are at most that many AND their text stays within `ceilingChars` (default
 * `MEMORY_PROMPT_CEILING_CHARS`); the first one that does not fit, and every one after it, is left
 * out and counted in `omitted` (the caller records it and the app asks the user to trim). Nothing
 * is shortened.
 */
export async function memoryContextFor(
  db: Db,
  botId: string,
  options: { limitItems?: number; ceilingChars?: number } = {},
): Promise<MemoryContext> {
  const id = uuidSchema.parse(botId);
  const limit =
    options.limitItems === undefined
      ? undefined
      : z.number().int().positive().parse(options.limitItems);
  const ceiling = z
    .number()
    .int()
    .positive()
    .parse(options.ceilingChars ?? MEMORY_PROMPT_CEILING_CHARS);
  const { sql } = db;
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where archived_at is null and status = 'active'
      and (
        (layer = 'rule' and (scope = 'shared' or bot_id = ${id}))
        or (layer = 'profile' and scope = 'shared')
      )
    order by created_at, id`;
  const all = rows.map(mapMemory);
  const totalChars = all.reduce((n, m) => n + m.text.length, 0);
  let kept = all;
  let omitted = { count: 0, chars: 0 };
  if (limit !== undefined && (all.length > limit || totalChars > ceiling)) {
    let used = 0;
    let cut = all.length;
    for (const [i, m] of all.entries()) {
      if (i >= limit || used + m.text.length > ceiling) {
        cut = i;
        break;
      }
      used += m.text.length;
    }
    kept = all.slice(0, cut);
    omitted = { count: all.length - cut, chars: totalChars - used };
  }
  return {
    rules: kept.filter((m) => m.layer === "rule"),
    profile: kept.filter((m) => m.layer === "profile"),
    omitted,
    totalChars,
  };
}

export interface PromptUsage {
  limitItems: number;
  ceilingChars: number;
  /** Active shared rules and profile facts (what every bot loads). */
  sharedItems: number;
  /** Characters of those. */
  sharedChars: number;
  /** The bots whose always-loaded memory does not fit under the item limit or the ceiling. */
  overBots: { botId: string; name: string; usedItems: number; usedChars: number }[];
}

/**
 * Which bots have more always-loaded memory (active rules and profile) than `limitItems`
 * memories or than the character ceiling.
 */
export async function memoryPromptUsage(
  db: Db,
  limitItems: number,
  ceilingChars: number = MEMORY_PROMPT_CEILING_CHARS,
): Promise<PromptUsage> {
  const limit = z.number().int().positive().parse(limitItems);
  const ceiling = z.number().int().positive().parse(ceilingChars);
  const { sql } = db;
  const [shared] = await sql<{ items: string; chars: string | null }[]>`
    select count(*) as items, sum(length(text)) as chars from memories
    where archived_at is null and status = 'active'
      and scope = 'shared' and layer in ('rule', 'profile')`;
  const sharedItems = Number(shared?.items ?? 0);
  const sharedChars = Number(shared?.chars ?? 0);
  const bots = await sql<{ id: string; name: string; items: string; own: string | null }[]>`
    select b.id, b.name,
      (select count(*) from memories m
        where m.bot_id = b.id and m.layer = 'rule' and m.scope = 'bot'
          and m.archived_at is null and m.status = 'active') as items,
      (select sum(length(m.text)) from memories m
        where m.bot_id = b.id and m.layer = 'rule' and m.scope = 'bot'
          and m.archived_at is null and m.status = 'active') as own
    from bots b where b.archived_at is null order by b.created_at, b.id`;
  const overBots = bots
    .map((b) => ({
      botId: b.id,
      name: b.name,
      usedItems: sharedItems + Number(b.items),
      usedChars: sharedChars + Number(b.own ?? 0),
    }))
    .filter((b) => b.usedItems > limit || b.usedChars > ceiling);
  return {
    limitItems: limit,
    ceilingChars: ceiling,
    sharedItems,
    sharedChars,
    overBots,
  };
}
