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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface CreateBotInput {
  name: string;
  description?: string;
  personality?: string;
  modelProvider: string;
  modelId: string;
  allowedTools?: string[];
  limits?: BotLimits;
}

export type UpdateBotInput = Partial<CreateBotInput>;

export async function createBot(db: Db, input: CreateBotInput): Promise<Bot> {
  const limits = botLimitsSchema.parse(input.limits ?? {});
  const [row] = await db.sql<BotRow[]>`
    insert into bots (name, description, personality, model_provider, model_id, allowed_tools, limits)
    values (
      ${input.name},
      ${input.description ?? ""},
      ${input.personality ?? ""},
      ${input.modelProvider},
      ${input.modelId},
      ${input.allowedTools ?? []}::text[],
      ${db.sql.json(limits)}
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
