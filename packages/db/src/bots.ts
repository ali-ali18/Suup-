import { z } from "zod";
import type { Db } from "./client.js";
import { joinFragments } from "./sql-util.js";
import { type Bot, type BotLimits, botLimitsSchema } from "./types.js";

interface BotRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  model_provider: string;
  model_id: string;
  allowed_tools: string[];
  limits: unknown;
  avatar: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export function mapBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    allowedTools: row.allowed_tools,
    limits: botLimitsSchema.parse(row.limits),
    avatar: row.avatar,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

const avatarSchema = z.string().min(1).max(2048).nullable();

export interface CreateBotInput {
  name: string;
  description?: string;
  personality?: string;
  modelProvider: string;
  modelId: string;
  allowedTools?: string[];
  limits?: BotLimits;
  /** Opaque reference the app interprets; `null` (or omitted) for none. */
  avatar?: string | null;
}

export type UpdateBotInput = Partial<CreateBotInput>;

export async function createBot(db: Db, input: CreateBotInput): Promise<Bot> {
  const limits = botLimitsSchema.parse(input.limits ?? {});
  const avatar = avatarSchema.parse(input.avatar ?? null);
  const [row] = await db.sql<BotRow[]>`
    insert into bots (name, description, personality, model_provider, model_id, allowed_tools, limits, avatar)
    values (
      ${input.name},
      ${input.description ?? ""},
      ${input.personality ?? ""},
      ${input.modelProvider},
      ${input.modelId},
      ${input.allowedTools ?? []}::text[],
      ${db.sql.json(limits)},
      ${avatar}
    )
    returning *`;
  if (!row) throw new Error("insert into bots returned no row");
  return mapBot(row);
}

export async function getBot(db: Db, id: string): Promise<Bot | null> {
  const [row] = await db.sql<BotRow[]>`select * from bots where id = ${id}`;
  return row ? mapBot(row) : null;
}

/** Newest first. Archived bots are excluded unless `includeArchived` is set. */
export async function listBots(db: Db, opts: { includeArchived?: boolean } = {}): Promise<Bot[]> {
  const rows = await db.sql<BotRow[]>`
    select * from bots
    where ${opts.includeArchived ? db.sql`true` : db.sql`archived_at is null`}
    order by created_at desc, id`;
  return rows.map(mapBot);
}

/** Updates only the given fields. Returns the updated bot, or `null` if it does not exist. */
export async function updateBot(db: Db, id: string, patch: UpdateBotInput): Promise<Bot | null> {
  const { sql } = db;
  const sets = [];
  if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
  if (patch.personality !== undefined) sets.push(sql`personality = ${patch.personality}`);
  if (patch.modelProvider !== undefined) sets.push(sql`model_provider = ${patch.modelProvider}`);
  if (patch.modelId !== undefined) sets.push(sql`model_id = ${patch.modelId}`);
  if (patch.allowedTools !== undefined) {
    sets.push(sql`allowed_tools = ${patch.allowedTools}::text[]`);
  }
  if (patch.limits !== undefined) {
    sets.push(sql`limits = ${sql.json(botLimitsSchema.parse(patch.limits))}`);
  }
  if (patch.avatar !== undefined) sets.push(sql`avatar = ${avatarSchema.parse(patch.avatar)}`);
  if (sets.length === 0) return getBot(db, id);
  const [row] = await sql<BotRow[]>`
    update bots set ${joinFragments(sql, sets)} where id = ${id} returning *`;
  return row ? mapBot(row) : null;
}

/** Soft delete. Idempotent: archiving twice keeps the first `archivedAt`. */
export async function archiveBot(db: Db, id: string): Promise<Bot | null> {
  const [row] = await db.sql<BotRow[]>`
    update bots set archived_at = coalesce(archived_at, now()) where id = ${id} returning *`;
  return row ? mapBot(row) : null;
}

/** Locks a hash so only one default change runs at a time (the unique index is the last guard). */
const DEFAULT_BOT_LOCK = "suup.default_bot";

/**
 * Makes this bot the default ("main") one, atomically unmarking the previous default. Returns the
 * bot, or `null` if it does not exist or is archived (an archived bot cannot be the default).
 */
export async function setDefaultBot(db: Db, botId: string): Promise<Bot | null> {
  return db.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${DEFAULT_BOT_LOCK}))`;
    const [target] = await tx<{ id: string }[]>`
      select id from bots where id = ${botId} and archived_at is null for no key update`;
    if (!target) return null;
    await tx`update bots set is_default = false where is_default and id <> ${botId}`;
    const [row] = await tx<BotRow[]>`
      update bots set is_default = true where id = ${botId} returning *`;
    return row ? mapBot(row) : null;
  });
}

/** The active bot marked as default, or `null` when none is. */
export async function getDefaultBot(db: Db): Promise<Bot | null> {
  const [row] = await db.sql<BotRow[]>`
    select * from bots where is_default and archived_at is null`;
  return row ? mapBot(row) : null;
}
