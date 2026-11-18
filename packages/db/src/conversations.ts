import { z } from "zod";
import { type Db, withTransaction } from "./client.js";

export type ConversationKind = "direct" | "group";
export const CONVERSATION_KINDS = ["direct", "group"] as const;

export interface ConversationMember {
  botId: string;
  /** Denormalized from `bots` so a list screen needs no second query. */
  name: string;
  avatar: string | null;
  joinedAt: Date;
}

/** Longest `text` of a `MessagePreview` (characters). */
export const MESSAGE_PREVIEW_LENGTH = 200;

export interface MessagePreview {
  id: string;
  seq: number;
  authorKind: "user" | "bot" | "system";
  authorBotId: string | null;
  /** The first `MESSAGE_PREVIEW_LENGTH` characters of the message. */
  text: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  /** `null` for direct conversations (the screen shows the bot's name). */
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  /** The user has read the conversation up to this message `seq` (0: nothing read yet). */
  lastReadSeq: number;
}

/** A conversation with its members, a preview of its last message and its unread count. */
export interface ConversationView extends Conversation {
  members: ConversationMember[];
  lastMessage: MessagePreview | null;
  /** Bot and system messages with a `seq` above `lastReadSeq` (the user's own never count). */
  unreadCount: number;
}

export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
  }
}

/** A conversation rule that the data-access layer enforces (the database cannot express it). */
export class ConversationRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationRuleError";
  }
}

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
  archived_at: Date | null;
  last_read_seq: string;
}

interface MemberRow {
  conversation_id: string;
  bot_id: string;
  name: string;
  avatar: string | null;
  joined_at: Date;
}

interface PreviewRow {
  id: string;
  conversation_id: string;
  seq: string;
  author_kind: "user" | "bot" | "system";
  author_bot_id: string | null;
  text: string;
  created_at: Date;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived_at,
    lastReadSeq: Number(row.last_read_seq),
  };
}

const uuidSchema = z.uuid();
const titleSchema = z.string().trim().min(1).max(200);

/** Fills members and last-message previews for the given conversations, keeping their order. */
async function toViews(db: Db, rows: ConversationRow[]): Promise<ConversationView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const members = await db.sql<MemberRow[]>`
    select cm.conversation_id, cm.bot_id, b.name, b.avatar, cm.joined_at
    from conversation_members cm join bots b on b.id = cm.bot_id
    where cm.conversation_id = any(${ids}::uuid[])
    order by cm.joined_at, cm.bot_id`;
  const previews = await db.sql<PreviewRow[]>`
    select distinct on (conversation_id)
      id, conversation_id, seq, author_kind, author_bot_id,
      left(text, ${MESSAGE_PREVIEW_LENGTH}) as text, created_at
    from messages
    where conversation_id = any(${ids}::uuid[])
    order by conversation_id, seq desc`;
  const unread = await db.sql<{ conversation_id: string; n: string }[]>`
    select m.conversation_id, count(*) as n
    from messages m join conversations c on c.id = m.conversation_id
    where m.conversation_id = any(${ids}::uuid[])
      and m.author_kind <> 'user' and m.seq > c.last_read_seq
    group by m.conversation_id`;
  const unreadBy = new Map(unread.map((u) => [u.conversation_id, Number(u.n)]));
  const membersBy = new Map<string, ConversationMember[]>();
  for (const m of members) {
    const list = membersBy.get(m.conversation_id) ?? [];
    list.push({ botId: m.bot_id, name: m.name, avatar: m.avatar, joinedAt: m.joined_at });
    membersBy.set(m.conversation_id, list);
  }
  const previewBy = new Map<string, MessagePreview>();
  for (const p of previews) {
    previewBy.set(p.conversation_id, {
      id: p.id,
      seq: Number(p.seq),
      authorKind: p.author_kind,
      authorBotId: p.author_bot_id,
      text: p.text,
      createdAt: p.created_at,
    });
  }
  return rows.map((row) => ({
    ...mapConversation(row),
    members: membersBy.get(row.id) ?? [],
    lastMessage: previewBy.get(row.id) ?? null,
    unreadCount: unreadBy.get(row.id) ?? 0,
  }));
}

async function viewOf(db: Db, id: string): Promise<ConversationView | null> {
  const rows = await db.sql<ConversationRow[]>`select * from conversations where id = ${id}`;
  return (await toViews(db, rows))[0] ?? null;
}

async function requireView(db: Db, id: string): Promise<ConversationView> {
  const view = await viewOf(db, id);
  if (!view) throw new ConversationNotFoundError(id);
  return view;
}

/** Throws `ConversationRuleError` unless every id is an existing, non-archived bot. */
async function assertActiveBots(db: Db, botIds: string[]): Promise<void> {
  const rows = await db.sql<{ id: string }[]>`
    select id from bots where id = any(${botIds}::uuid[]) and archived_at is null`;
  const found = new Set(rows.map((r) => r.id));
  const missing = botIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ConversationRuleError(`Unknown or archived bot: ${missing.join(", ")}`);
  }
}

/**
 * The direct conversation with a bot. Idempotent: there is at most one per bot (the database
 * enforces it), so a second call returns the existing one. If that one was archived it is
 * reopened (`archivedAt` cleared), keeping the history. Throws `ConversationRuleError` if the bot
 * does not exist or is archived and no conversation exists yet.
 */
export async function createDirectConversation(db: Db, botId: string): Promise<ConversationView> {
  const id = uuidSchema.parse(botId);
  const conversationId = await withTransaction(db, async (tx) => {
    // Serializes creators for this bot (does not block other tables' foreign-key checks).
    const [bot] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from bots where id = ${id} for no key update`;
    const [existing] = await tx.sql<{ id: string }[]>`
      select c.id from conversations c
      join conversation_members cm on cm.conversation_id = c.id
      where cm.bot_id = ${id} and c.kind = 'direct'`;
    if (existing) {
      await tx.sql`update conversations set archived_at = null where id = ${existing.id} and archived_at is not null`;
      return existing.id;
    }
    if (!bot || bot.archived_at !== null) {
      throw new ConversationRuleError(`Unknown or archived bot: ${id}`);
    }
    const [conv] = await tx.sql<{ id: string }[]>`
      insert into conversations (kind) values ('direct') returning id`;
    if (!conv) throw new Error("insert into conversations returned no row");
    await tx.sql`
      insert into conversation_members (conversation_id, conversation_kind, bot_id)
      values (${conv.id}, 'direct', ${id})`;
    return conv.id;
  });
  return requireView(db, conversationId);
}

export interface CreateGroupConversationInput {
  title: string;
  botIds: string[];
}

/** A group room. Needs a title and at least one distinct, active bot. */
export async function createGroupConversation(
  db: Db,
  input: CreateGroupConversationInput,
): Promise<ConversationView> {
  const title = titleSchema.parse(input.title);
  const botIds = [...new Set(z.array(uuidSchema).min(1).parse(input.botIds))];
  const conversationId = await withTransaction(db, async (tx) => {
    await assertActiveBots(tx, botIds);
    const [conv] = await tx.sql<{ id: string }[]>`
      insert into conversations (kind, title) values ('group', ${title}) returning id`;
    if (!conv) throw new Error("insert into conversations returned no row");
    for (const botId of botIds) {
      await tx.sql`
        insert into conversation_members (conversation_id, conversation_kind, bot_id)
        values (${conv.id}, 'group', ${botId})`;
    }
    return conv.id;
  });
  return requireView(db, conversationId);
}

export async function getConversation(db: Db, id: string): Promise<ConversationView | null> {
  return viewOf(db, uuidSchema.parse(id));
}

export interface ListConversationsOptions {
  includeArchived?: boolean;
  /** Maximum number of conversations. Default: no limit. */
  limit?: number;
}

/**
 * Most recent activity first (`last_message_at desc nulls last`, then newest created), each with
 * its members and a preview of its last message. Archived ones are excluded unless
 * `includeArchived` is set.
 */
export async function listConversations(
  db: Db,
  opts: ListConversationsOptions = {},
): Promise<ConversationView[]> {
  const { sql } = db;
  const limit = opts.limit === undefined ? null : z.number().int().positive().parse(opts.limit);
  const rows = await sql<ConversationRow[]>`
    select * from conversations
    where ${opts.includeArchived ? sql`true` : sql`archived_at is null`}
    order by last_message_at desc nulls last, created_at desc, id
    ${limit === null ? sql`` : sql`limit ${limit}`}`;
  return toViews(db, rows);
}

/** Locks the conversation row for the rest of the transaction and checks it can change members. */
async function lockGroup(tx: Db, conversationId: string): Promise<void> {
  const [conv] = await tx.sql<{ kind: ConversationKind; archived_at: Date | null }[]>`
    select kind, archived_at from conversations where id = ${conversationId} for no key update`;
  if (!conv) throw new ConversationNotFoundError(conversationId);
  if (conv.kind !== "group") {
    throw new ConversationRuleError("Members can only be changed in a group conversation");
  }
  if (conv.archived_at !== null) {
    throw new ConversationRuleError("Members cannot be changed in an archived conversation");
  }
}

/** Adds a bot to a group. Idempotent. Group only; the bot must exist and be active. */
export async function addMember(
  db: Db,
  conversationId: string,
  botId: string,
): Promise<ConversationView> {
  const cid = uuidSchema.parse(conversationId);
  const bid = uuidSchema.parse(botId);
  await withTransaction(db, async (tx) => {
    await lockGroup(tx, cid);
    await assertActiveBots(tx, [bid]);
    await tx.sql`
      insert into conversation_members (conversation_id, conversation_kind, bot_id)
      values (${cid}, 'group', ${bid})
      on conflict (conversation_id, bot_id) do nothing`;
  });
  return requireView(db, cid);
}

/**
 * Removes a bot from a group. Idempotent (a bot that is not a member is ignored). Group only, and
 * the last member cannot be removed: archive the conversation instead.
 */
export async function removeMember(
  db: Db,
  conversationId: string,
  botId: string,
): Promise<ConversationView> {
  const cid = uuidSchema.parse(conversationId);
  const bid = uuidSchema.parse(botId);
  await withTransaction(db, async (tx) => {
    await lockGroup(tx, cid);
    const [count] = await tx.sql<{ n: string; is_member: boolean }[]>`
      select count(*) as n, bool_or(bot_id = ${bid}) as is_member
      from conversation_members where conversation_id = ${cid}`;
    if (!count?.is_member) return;
    if (Number(count.n) <= 1) {
      throw new ConversationRuleError("A group conversation must keep at least one member");
    }
    await tx.sql`delete from conversation_members where conversation_id = ${cid} and bot_id = ${bid}`;
  });
  return requireView(db, cid);
}

/** Soft delete. Idempotent: archiving twice keeps the first `archivedAt`. `null` if unknown. */
export async function archiveConversation(
  db: Db,
  conversationId: string,
): Promise<ConversationView | null> {
  const id = uuidSchema.parse(conversationId);
  await db.sql`
    update conversations set archived_at = coalesce(archived_at, now()) where id = ${id}`;
  return viewOf(db, id);
}

/**
 * Marks the conversation as read up to a message: `upToSeq` (clamped to the last message), or all
 * of it when omitted. It never moves backwards (reading an old message does not "unread" the
 * newer ones). Idempotent. `null` if the conversation does not exist.
 */
export async function markConversationRead(
  db: Db,
  conversationId: string,
  upToSeq?: number,
): Promise<ConversationView | null> {
  const id = uuidSchema.parse(conversationId);
  const upTo = upToSeq === undefined ? undefined : z.number().int().nonnegative().parse(upToSeq);
  await db.sql`
    update conversations c set last_read_seq = greatest(
      c.last_read_seq,
      least(
        coalesce(${upTo ?? null}::bigint, 9223372036854775807),
        coalesce((select max(seq) from messages where conversation_id = c.id), 0)
      )
    )
    where c.id = ${id}`;
  return viewOf(db, id);
}
