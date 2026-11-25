import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { joinFragments } from "./sql-util.js";
import { type Bot, type BotLimits, botLimitsSchema } from "./types.js";

export interface BotRow {
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
  pinned: boolean;
  group_name: string | null;
  sort_order: number | null;
  color: string | null;
  avatar_style: string;
  avatar_pixel3d: boolean;
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
    pinned: row.pinned,
    groupName: row.group_name,
    sortOrder: row.sort_order,
    color: row.color,
    avatarStyle: row.avatar_style === "pixel" ? "pixel" : "shapes",
    avatarPixel3d: row.avatar_pixel3d === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

const avatarSchema = z.string().min(1).max(2048).nullable();
const groupSchema = z
  .string()
  .transform((g) => g.trim())
  .pipe(z.string().min(1).max(60))
  .nullable();
const colorSchema = z.string().min(1).max(40).nullable();
const avatarStyleSchema = z.enum(["shapes", "pixel"]);
const orderSchema = z.number().int().nullable();

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
  pinned?: boolean;
  /** `null` (or omitted): the default list. Trimmed, 1 to 60 characters. */
  groupName?: string | null;
  sortOrder?: number | null;
  /** The id of a colour of the palette (checked by the caller, which knows the palette). */
  color?: string | null;
  /** `shapes` (the default) or `pixel`: which family of mascots `avatar` names. */
  avatarStyle?: "shapes" | "pixel";
  /** Only for `pixel`: draw the mascot in 3D (default `false`). */
  avatarPixel3d?: boolean;
}

export type UpdateBotInput = Partial<CreateBotInput>;

export async function createBot(
  db: Db,
  input: CreateBotInput,
  options: { makeDefault?: boolean } = {},
): Promise<Bot> {
  if (options.makeDefault === true) {
    return withTransaction(db, async (tx) => {
      const bot = await createBot(tx, input);
      const promoted = await promoteDefaultBot(tx, bot.id);
      if (promoted === null) throw new Error("new bot could not be made default");
      return promoted;
    });
  }
  const limits = botLimitsSchema.parse(input.limits ?? {});
  const avatar = avatarSchema.parse(input.avatar ?? null);
  // Only named when given: databases from before migration 0025 (tests that build old schemas) have no column.
  const style =
    input.avatarStyle === undefined ? undefined : avatarStyleSchema.parse(input.avatarStyle);
  const pixel3d = input.avatarPixel3d;
  const [row] = await db.sql<BotRow[]>`
    insert into bots (name, description, personality, model_provider, model_id, allowed_tools, limits, avatar, pinned, group_name, sort_order, color${style === undefined ? db.sql`` : db.sql`, avatar_style`}${pixel3d === undefined ? db.sql`` : db.sql`, avatar_pixel3d`})
    values (
      ${input.name},
      ${input.description ?? ""},
      ${input.personality ?? ""},
      ${input.modelProvider},
      ${input.modelId},
      ${input.allowedTools ?? []}::text[],
      ${db.sql.json(limits)},
      ${avatar},
      ${input.pinned ?? false},
      ${groupSchema.parse(input.groupName ?? null)},
      ${orderSchema.parse(input.sortOrder ?? null)},
      ${colorSchema.parse(input.color ?? null)}${style === undefined ? db.sql`` : db.sql`, ${style}`}${pixel3d === undefined ? db.sql`` : db.sql`, ${pixel3d}`}
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
  if (patch.pinned !== undefined) sets.push(sql`pinned = ${patch.pinned}`);
  if (patch.groupName !== undefined)
    sets.push(sql`group_name = ${groupSchema.parse(patch.groupName)}`);
  if (patch.sortOrder !== undefined)
    sets.push(sql`sort_order = ${orderSchema.parse(patch.sortOrder)}`);
  if (patch.color !== undefined) sets.push(sql`color = ${colorSchema.parse(patch.color)}`);
  if (patch.avatarStyle !== undefined)
    sets.push(sql`avatar_style = ${avatarStyleSchema.parse(patch.avatarStyle)}`);
  if (patch.avatarPixel3d !== undefined) sets.push(sql`avatar_pixel3d = ${patch.avatarPixel3d}`);
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
  return withTransaction(db, (tx) => promoteDefaultBot(tx, botId));
}

async function promoteDefaultBot(db: Db, botId: string): Promise<Bot | null> {
  const tx = db.sql;
  await tx`select pg_advisory_xact_lock(hashtext(${DEFAULT_BOT_LOCK}))`;
  const [target] = await tx<{ id: string }[]>`
      select id from bots where id = ${botId} and archived_at is null for no key update`;
  if (!target) return null;
  await tx`update bots set is_default = false where is_default and id <> ${botId}`;
  const [row] = await tx<BotRow[]>`
      update bots set is_default = true where id = ${botId} returning *`;
  return row ? mapBot(row) : null;
}

/** The active bot marked as default, or `null` when none is. */
export async function getDefaultBot(db: Db): Promise<Bot | null> {
  const [row] = await db.sql<BotRow[]>`
    select * from bots where is_default and archived_at is null`;
  return row ? mapBot(row) : null;
}
