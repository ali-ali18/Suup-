import { z } from "zod";
import type { Db } from "./client.js";
import { SEARCH_HEADLINE_OPTIONS, searchQuerySchema } from "./messages.js";

export const MEMORY_LAYERS = ["rule", "profile", "note", "journal"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export const MEMORY_SCOPES = ["shared", "bot"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_CREATORS = ["user", "bot"] as const;
export type MemoryCreator = (typeof MEMORY_CREATORS)[number];

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
  "embedding_ready",
  "created_at",
  "updated_at",
  "archived_at",
];

const uuidSchema = z.uuid();
const layerSchema = z.enum(MEMORY_LAYERS);
const scopeSchema = z.enum(MEMORY_SCOPES);
const textSchema = z.string().refine((t) => t.trim().length > 0, "text must not be blank");
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
  sourceConversationId?: string;
  sourceRunId?: string;
  sourceMessageId?: string;
  createdBy: MemoryCreator;
}

const addSchema = z
  .object({
    layer: layerSchema,
    scope: z.exactOptional(scopeSchema),
    botId: z.exactOptional(uuidSchema),
    text: textSchema,
    sourceConversationId: z.exactOptional(uuidSchema),
    sourceRunId: z.exactOptional(uuidSchema),
    sourceMessageId: z.exactOptional(uuidSchema),
    createdBy: z.enum(MEMORY_CREATORS),
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
    return { ...m, scope };
  });

/** Saves a memory. The layer/scope rules are checked here (clear errors) and by the database. */
export async function addMemory(db: Db, input: AddMemoryInput): Promise<Memory> {
  const m = addSchema.parse(input);
  const [row] = await db.sql<MemoryRow[]>`
    insert into memories (
      layer, scope, bot_id, text,
      source_conversation_id, source_run_id, source_message_id, created_by
    )
    values (
      ${m.layer}, ${m.scope}, ${m.botId ?? null}, ${m.text},
      ${m.sourceConversationId ?? null}, ${m.sourceRunId ?? null}, ${m.sourceMessageId ?? null},
      ${m.createdBy}
    )
    returning ${db.sql(MEMORY_COLUMNS)}`;
  if (!row) throw new Error("insert into memories returned no row");
  return mapMemory(row);
}

export interface AddJournalInput {
  botId: string;
  text: string;
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
  const [row] = await db.sql<MemoryRow[]>`
    insert into memories (layer, scope, bot_id, text, source_conversation_id, source_run_id, created_by)
    values ('journal', 'bot', ${botId}, ${textSchema.parse(input.text)}, ${conversationId}, ${runId}, 'bot')
    on conflict (source_run_id) where layer = 'journal' and source_run_id is not null do nothing
    returning ${db.sql(MEMORY_COLUMNS)}`;
  return row ? mapMemory(row) : null;
}

export async function getMemory(db: Db, id: string): Promise<Memory | null> {
  const [row] = await db.sql<MemoryRow[]>`
    select ${db.sql(MEMORY_COLUMNS)} from memories where id = ${uuidSchema.parse(id)}`;
  return row ? mapMemory(row) : null;
}

/**
 * Corrects the text of a memory (nothing else can change: layer, scope and origin are fixed).
 * Bumps `updated_at` and clears `embedding_ready`, since the vector of the old text is stale.
 * Returns `null` if the memory does not exist.
 */
export async function updateMemory(db: Db, id: string, text: string): Promise<Memory | null> {
  const [row] = await db.sql<MemoryRow[]>`
    update memories set text = ${textSchema.parse(text)}, embedding_ready = false
    where id = ${uuidSchema.parse(id)}
    returning ${db.sql(MEMORY_COLUMNS)}`;
  return row ? mapMemory(row) : null;
}

/** Forgets a memory (soft). Idempotent: archiving twice keeps the first `archivedAt`. */
export async function archiveMemory(db: Db, id: string): Promise<Memory | null> {
  const [row] = await db.sql<MemoryRow[]>`
    update memories set archived_at = coalesce(archived_at, now())
    where id = ${uuidSchema.parse(id)}
    returning ${db.sql(MEMORY_COLUMNS)}`;
  return row ? mapMemory(row) : null;
}

/** Undoes `archiveMemory`. Idempotent. */
export async function restoreMemory(db: Db, id: string): Promise<Memory | null> {
  const [row] = await db.sql<MemoryRow[]>`
    update memories set archived_at = null
    where id = ${uuidSchema.parse(id)}
    returning ${db.sql(MEMORY_COLUMNS)}`;
  return row ? mapMemory(row) : null;
}

export interface ListMemoriesOptions {
  layer?: MemoryLayer;
  scope?: MemoryScope;
  /** Only memories that belong to this bot (its own `bot`-scoped ones). */
  botId?: string;
  includeArchived?: boolean;
  limit: number;
}

/**
 * The management view (what the user sees on the memory screen): plain filters, no per-bot
 * visibility rule. Oldest first (`created_at`, `id`). Archived ones only with `includeArchived`.
 */
export async function listMemories(db: Db, opts: ListMemoriesOptions): Promise<Memory[]> {
  const { sql } = db;
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where ${opts.includeArchived ? sql`true` : sql`archived_at is null`}
      and ${opts.layer !== undefined ? sql`layer = ${layerSchema.parse(opts.layer)}` : sql`true`}
      and ${opts.scope !== undefined ? sql`scope = ${scopeSchema.parse(opts.scope)}` : sql`true`}
      and ${opts.botId !== undefined ? sql`bot_id = ${uuidSchema.parse(opts.botId)}` : sql`true`}
    order by created_at, id
    limit ${limitSchema.parse(opts.limit)}`;
  return rows.map(mapMemory);
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
    with q as (select suup_search_query(${query}) as tsq)
    select ${sql(MEMORY_COLUMNS.map((c) => `m.${c}`))},
      ts_rank(m.search, q.tsq) as rank,
      ts_headline('portuguese', m.text, q.tsq, ${SEARCH_HEADLINE_OPTIONS}) as excerpt
    from memories m, q
    where numnode(q.tsq) > 0
      and m.search @@ q.tsq
      and m.archived_at is null
      and (m.scope = 'shared' ${botId !== undefined ? sql`or m.bot_id = ${botId}` : sql``})
      and ${layers !== undefined ? sql`m.layer = any(${layers}::text[])` : sql`true`}
    order by rank desc, m.created_at, m.id
    limit ${limit}`;
  return rows.map((r) => ({ memory: mapMemory(r), excerpt: r.excerpt, rank: Number(r.rank) }));
}

export interface MemoryContext {
  /** Standing orders: the shared rules and this bot's own, oldest first. */
  rules: Memory[];
  /** The shared profile, oldest first. */
  profile: Memory[];
}

/**
 * Everything that goes into every run of this bot: the shared rules, the bot's own rules and the
 * shared profile (active ones only). Each list is ordered by (`created_at`, `id`), so the text
 * built from it stays byte-identical until a memory changes, which keeps the prompt prefix
 * cacheable.
 */
export async function memoryContextFor(db: Db, botId: string): Promise<MemoryContext> {
  const id = uuidSchema.parse(botId);
  const { sql } = db;
  const rows = await sql<MemoryRow[]>`
    select ${sql(MEMORY_COLUMNS)} from memories
    where archived_at is null
      and (
        (layer = 'rule' and (scope = 'shared' or bot_id = ${id}))
        or (layer = 'profile' and scope = 'shared')
      )
    order by created_at, id`;
  const memories = rows.map(mapMemory);
  return {
    rules: memories.filter((m) => m.layer === "rule"),
    profile: memories.filter((m) => m.layer === "profile"),
  };
}
