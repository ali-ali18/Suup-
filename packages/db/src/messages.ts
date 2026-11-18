import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ConversationNotFoundError, ConversationRuleError } from "./conversations.js";

export type MessageAuthorKind = "user" | "bot" | "system";
export const MESSAGE_AUTHOR_KINDS = ["user", "bot", "system"] as const;
export type MessageStatus = "sent" | "delivered";
export const MESSAGE_STATUSES = ["sent", "delivered"] as const;

export interface Message {
  id: string;
  conversationId: string;
  /** Position inside the conversation, starting at 1, without gaps. */
  seq: number;
  authorKind: MessageAuthorKind;
  /** Set exactly when `authorKind` is `"bot"`. */
  authorBotId: string | null;
  text: string;
  /** User message: the run it opened. Bot message: the run that produced it. */
  runId: string | null;
  /**
   * User messages sent while a run was working: `sent` until the bot reads it, then `delivered`.
   * `null` for everything else.
   */
  status: MessageStatus | null;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string;
  author_kind: MessageAuthorKind;
  author_bot_id: string | null;
  text: string;
  run_id: string | null;
  status: MessageStatus | null;
  created_at: Date;
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    // postgres.js returns bigint as string; a conversation will never reach 2^53 messages.
    seq: Number(row.seq),
    authorKind: row.author_kind,
    authorBotId: row.author_bot_id,
    text: row.text,
    runId: row.run_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

// Explicit columns: `select *` would also ship the `search` tsvector.
const MESSAGE_COLUMNS = [
  "id",
  "conversation_id",
  "seq",
  "author_kind",
  "author_bot_id",
  "text",
  "run_id",
  "status",
  "created_at",
];

const uuidSchema = z.uuid();
const textSchema = z.string().refine((t) => t.trim().length > 0, "text must not be blank");

const appendSchema = z
  .object({
    conversationId: uuidSchema,
    authorKind: z.enum(MESSAGE_AUTHOR_KINDS),
    authorBotId: z.exactOptional(uuidSchema),
    text: textSchema,
    runId: z.exactOptional(uuidSchema),
    status: z.exactOptional(z.enum(MESSAGE_STATUSES)),
  })
  .superRefine((m, ctx) => {
    if ((m.authorKind === "bot") !== (m.authorBotId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["authorBotId"],
        message: "authorBotId is required when authorKind is 'bot', and not allowed otherwise",
      });
    }
    if (m.status !== undefined && m.authorKind !== "user") {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "status only applies to user messages",
      });
    }
  });

export interface AppendMessageInput {
  conversationId: string;
  authorKind: MessageAuthorKind;
  /** Required for `bot` messages (and the bot must be a member), not allowed for the others. */
  authorBotId?: string;
  text: string;
  runId?: string;
  /** User messages only; see `Message.status`. */
  status?: MessageStatus;
}

/**
 * Appends a message with the next `seq` (1, 2, 3, ... without gaps) and bumps the conversation's
 * `last_message_at`. Appends to the same conversation are serialized by locking its row
 * (`FOR NO KEY UPDATE`) inside the transaction, so concurrent callers queue up instead of racing
 * for a `seq`, exactly like `appendRunEvent`.
 *
 * Throws `ConversationNotFoundError`; `ConversationRuleError` for an archived conversation or a
 * bot author that is not a member; a `ZodError` for malformed input.
 */
export async function appendMessage(db: Db, input: AppendMessageInput): Promise<Message> {
  const m = appendSchema.parse(input);
  return withTransaction(db, async (tx) => {
    const [conv] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from conversations where id = ${m.conversationId} for no key update`;
    if (!conv) throw new ConversationNotFoundError(m.conversationId);
    if (conv.archived_at !== null) {
      throw new ConversationRuleError("Cannot add messages to an archived conversation");
    }
    if (m.authorBotId !== undefined) {
      const [member] = await tx.sql<{ one: number }[]>`
        select 1 as one from conversation_members
        where conversation_id = ${m.conversationId} and bot_id = ${m.authorBotId}`;
      if (!member) {
        throw new ConversationRuleError(
          `Bot ${m.authorBotId} is not a member of conversation ${m.conversationId}`,
        );
      }
    }
    const [row] = await tx.sql<MessageRow[]>`
      insert into messages (conversation_id, seq, author_kind, author_bot_id, text, run_id, status, created_at)
      values (
        ${m.conversationId},
        (select coalesce(max(seq), 0) + 1 from messages where conversation_id = ${m.conversationId}),
        ${m.authorKind},
        ${m.authorBotId ?? null},
        ${m.text},
        ${m.runId ?? null},
        ${m.status ?? null},
        clock_timestamp()
      )
      returning ${tx.sql(MESSAGE_COLUMNS)}`;
    if (!row) throw new Error("insert into messages returned no row");
    await tx.sql`
      update conversations set last_message_at = ${row.created_at} where id = ${m.conversationId}`;
    return mapMessage(row);
  });
}

export async function getMessage(db: Db, id: string): Promise<Message | null> {
  const [row] = await db.sql<MessageRow[]>`
    select ${db.sql(MESSAGE_COLUMNS)} from messages where id = ${uuidSchema.parse(id)}`;
  return row ? mapMessage(row) : null;
}

export interface ListMessagesOptions {
  /** Only messages with `seq` lower than this (exclusive). */
  beforeSeq?: number;
  /** Only messages with `seq` greater than this (exclusive). */
  afterSeq?: number;
  limit: number;
}

/**
 * A page of messages, always returned in ascending `seq`.
 *
 * - no cursor: the newest `limit` messages (the chat opens at the bottom);
 * - `beforeSeq`: the `limit` messages immediately before it (scrolling up); also the choice
 *   when both cursors are given (the newest `limit` of the range);
 * - `afterSeq` alone: the first `limit` messages after it (catching up on new ones).
 */
export async function listMessages(
  db: Db,
  conversationId: string,
  opts: ListMessagesOptions,
): Promise<Message[]> {
  const cid = uuidSchema.parse(conversationId);
  const limit = z.number().int().positive().parse(opts.limit);
  const before = z.number().int().optional().parse(opts.beforeSeq);
  const after = z.number().int().optional().parse(opts.afterSeq);
  const { sql } = db;
  const range = sql`
    conversation_id = ${cid}
    and ${before !== undefined ? sql`seq < ${before}` : sql`true`}
    and ${after !== undefined ? sql`seq > ${after}` : sql`true`}`;
  if (after !== undefined && before === undefined) {
    const rows = await sql<MessageRow[]>`
      select ${sql(MESSAGE_COLUMNS)} from messages where ${range} order by seq limit ${limit}`;
    return rows.map(mapMessage);
  }
  const rows = await sql<MessageRow[]>`
    select ${sql(MESSAGE_COLUMNS)} from messages where ${range} order by seq desc limit ${limit}`;
  return rows.reverse().map(mapMessage);
}

/**
 * Marks a user message as read by the bot (`sent` -> `delivered`). Idempotent. Messages that have
 * no status (bot and system messages, user messages sent with no run working) are returned as
 * they are. `null` if the message does not exist.
 */
export async function markMessageDelivered(db: Db, messageId: string): Promise<Message | null> {
  const id = uuidSchema.parse(messageId);
  const [row] = await db.sql<MessageRow[]>`
    update messages set status = 'delivered' where id = ${id} and status = 'sent'
    returning ${db.sql(MESSAGE_COLUMNS)}`;
  return row ? mapMessage(row) : getMessage(db, id);
}

/** Wraps the words a search hit matched in an excerpt (control characters, so no text clashes). */
export const HIGHLIGHT_START = "\u0002";
export const HIGHLIGHT_END = "\u0003";

/** `ts_headline` options shared by message and memory search. */
export const SEARCH_HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_END}, MaxWords=24, MinWords=8, MaxFragments=1`;

/** Search text comes from users and models: no NUL (Postgres cannot store it), bounded length. */
export const searchQuerySchema = z
  .string()
  .max(1000)
  .transform((q) => q.replaceAll("\u0000", " "));

export interface SearchMessagesOptions {
  query: string;
  /** Only this conversation. */
  conversationId?: string;
  /** Only conversations this bot is a member of. */
  botId?: string;
  limit: number;
}

export interface MessageSearchHit {
  message: Message;
  /** A short passage of the text around the match; matched words are wrapped in
   * `HIGHLIGHT_START` / `HIGHLIGHT_END`. */
  excerpt: string;
  /** `ts_rank` score; higher is better. */
  rank: number;
}

/**
 * Full-text search (Portuguese: stemming and stop words, so "provas" finds "prova") over messages,
 * best match first, newest first among equals. `query` is parsed by `websearch_to_tsquery`, which
 * accepts any string (quotes, `or`, `-word`) and never raises a syntax error; a query with no
 * searchable terms (empty, only stop words or punctuation) returns `[]`.
 */
export async function searchMessages(
  db: Db,
  opts: SearchMessagesOptions,
): Promise<MessageSearchHit[]> {
  const query = searchQuerySchema.parse(opts.query);
  const limit = z.number().int().positive().parse(opts.limit);
  const conversationId = opts.conversationId && uuidSchema.parse(opts.conversationId);
  const botId = opts.botId && uuidSchema.parse(opts.botId);
  const { sql } = db;
  const rows = await sql<(MessageRow & { excerpt: string; rank: number })[]>`
    with q as (select websearch_to_tsquery('portuguese', ${query}) as tsq)
    select ${sql(MESSAGE_COLUMNS.map((c) => `m.${c}`))},
      ts_rank(m.search, q.tsq) as rank,
      ts_headline('portuguese', m.text, q.tsq, ${SEARCH_HEADLINE_OPTIONS}) as excerpt
    from messages m, q
    where numnode(q.tsq) > 0
      and m.search @@ q.tsq
      and ${conversationId ? sql`m.conversation_id = ${conversationId}` : sql`true`}
      and ${
        botId
          ? sql`exists (
              select 1 from conversation_members cm
              where cm.conversation_id = m.conversation_id and cm.bot_id = ${botId})`
          : sql`true`
      }
    order by rank desc, m.created_at desc, m.id
    limit ${limit}`;
  return rows.map((r) => ({ message: mapMessage(r), excerpt: r.excerpt, rank: Number(r.rank) }));
}
