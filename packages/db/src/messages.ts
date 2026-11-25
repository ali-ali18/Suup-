import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ConversationNotFoundError, ConversationRuleError } from "./conversations.js";

export type MessageAuthorKind = "user" | "bot" | "system";
export const MESSAGE_AUTHOR_KINDS = ["user", "bot", "system"] as const;
export type MessageStatus = "sent" | "delivered";
export const MESSAGE_STATUSES = ["sent", "delivered"] as const;

/** A choice offered with a question. */
export interface MessageQuestionOption {
  label: string;
  description?: string;
}

/** One question of what the bot asked. */
export interface MessageQuestionItem {
  question: string;
  options?: MessageQuestionOption[];
  multiple?: boolean;
  allowOther?: boolean;
}

/**
 * The structured side of a bot message that is a question (an `escalate`, or the reviewer's
 * tie-break), in ONE shape: what was asked (one question, or a questionnaire) and, for the
 * tie-break, why it was asked.
 */
export interface MessageQuestion {
  questions: MessageQuestionItem[];
  reason?: "review_tie_break" | "progress_limit";
  /**
   * What the bot wrote besides the question, in the same turn (the chat's bubble above the card).
   * Absent when it only asked: the card, whose title is the question, is then all there is.
   */
  lead?: string;
  /** The user closed the card with its X: no option will be chosen (`dismissQuestion`). */
  dismissed?: boolean;
}

/** A file a bot message shows (`send_file`): what the chat draws; the content is in `files`. */
export interface MessageAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** One bot proposed on a team card: what the draft feature wrote, for the user to tick. */
export interface TeamProposalItem {
  name: string;
  description: string;
  personality: string;
}

/**
 * The team card of a bot message (docs/RECEPCAO.md): the proposals, and what the user decided.
 * `pending` waits for the user; `created` lists the bots that were made from the ticked proposals
 * (by index); `dismissed` is "Agora não". Only the user's decision, through the API, creates bots.
 */
export interface TeamProposal {
  items: TeamProposalItem[];
  status: "pending" | "created" | "dismissed";
  created: { index: number; botId: string }[];
}

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
  /** Present only on a bot message that asks the user something. */
  question?: MessageQuestion;
  /** Present only on a bot message that proposes a team of bots. */
  team?: TeamProposal;
  /** The routine whose run this message reports (docs/ROTINAS.md); `null` for any other message. */
  routineId: string | null;
  /**
   * User messages only: the routine this message is about (the app's "Editar" binds it to the
   * draft). Structured, never in `text`; the harness tells the model which routine it is.
   */
  routineRef: string | null;
  /** Bot or system messages only: the files the run sent with it (`send_file`), oldest first. */
  attachments?: MessageAttachment[];
  /**
   * Present only on a message the harness wrote once for something that happened in a run (its end,
   * a pause, a request for a secret): the key that makes it idempotent. The app links a card to the
   * message that is its own words by this exact key.
   */
  dedupeKey?: string;
  /**
   * Present only on a part: the text the bot wrote in a turn that also called tools. The `seq` of
   * the run's `model_response` event that carried it; the app orders the part against the cards of
   * the same run by it (never by time).
   */
  eventSeq?: number;
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
  question: MessageQuestion | null;
  team: TeamProposal | null;
  routine_id: string | null;
  routine_ref: string | null;
  attachments: MessageAttachment[] | null;
  dedupe_key?: string | null;
  event_seq?: number | null;
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
    ...(row.question === null || row.question === undefined ? {} : { question: row.question }),
    ...(row.team === null || row.team === undefined ? {} : { team: row.team }),
    routineId: row.routine_id ?? null,
    routineRef: row.routine_ref ?? null,
    ...(row.attachments === null || row.attachments === undefined || row.attachments.length === 0
      ? {}
      : { attachments: row.attachments }),
    ...(row.dedupe_key === null || row.dedupe_key === undefined
      ? {}
      : { dedupeKey: row.dedupe_key }),
    ...(row.event_seq === null || row.event_seq === undefined ? {} : { eventSeq: row.event_seq }),
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
  "question",
  "team",
  "routine_id",
  "routine_ref",
  "attachments",
  "dedupe_key",
  "event_seq",
];

const uuidSchema = z.uuid();
const textSchema = z.string().refine((t) => t.trim().length > 0, "text must not be blank");

const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        options: z.exactOptional(
          z
            .array(
              z.object({
                label: z.string().min(1),
                description: z.exactOptional(z.string().min(1)),
              }),
            )
            .min(2)
            .max(6),
        ),
        multiple: z.exactOptional(z.boolean()),
        allowOther: z.exactOptional(z.boolean()),
      }),
    )
    .min(1)
    .max(5),
  reason: z.exactOptional(z.enum(["review_tie_break", "progress_limit"])),
  lead: z.exactOptional(z.string().min(1)),
  dismissed: z.exactOptional(z.boolean()),
});

export const teamProposalItemSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  personality: z.string().trim().min(1).max(6000),
});

const appendSchema = z
  .object({
    conversationId: uuidSchema,
    authorKind: z.enum(MESSAGE_AUTHOR_KINDS),
    authorBotId: z.exactOptional(uuidSchema),
    text: textSchema,
    runId: z.exactOptional(uuidSchema),
    status: z.exactOptional(z.enum(MESSAGE_STATUSES)),
    dedupeKey: z.exactOptional(z.string().min(1).max(200)),
    question: z.exactOptional(questionSchema),
    team: z.exactOptional(z.array(teamProposalItemSchema).min(1).max(5)),
    routineId: z.exactOptional(uuidSchema),
    routineRef: z.exactOptional(uuidSchema),
    eventSeq: z.exactOptional(z.number().int().positive()),
    attachFiles: z.exactOptional(z.boolean()),
  })
  .superRefine((m, ctx) => {
    if (m.routineRef !== undefined && m.authorKind !== "user") {
      ctx.addIssue({
        code: "custom",
        path: ["routineRef"],
        message: "routineRef only applies to user messages",
      });
    }
    if ((m.authorKind === "bot") !== (m.authorBotId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["authorBotId"],
        message: "authorBotId is required when authorKind is 'bot', and not allowed otherwise",
      });
    }
    if (m.question !== undefined && m.authorKind !== "bot") {
      ctx.addIssue({
        code: "custom",
        path: ["question"],
        message: "question only applies to bot messages",
      });
    }
    if (m.team !== undefined && m.authorKind !== "bot") {
      ctx.addIssue({
        code: "custom",
        path: ["team"],
        message: "team only applies to bot messages",
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
  /**
   * Makes the append idempotent per conversation: if a message with this key already exists it is
   * returned and nothing is written (see `appendMessageOnce` to know which happened). The harness
   * uses it for what it writes on its own, so a retry or another worker cannot write it twice.
   */
  dedupeKey?: string;
  /** Bot messages only: the structured question (choices) this message asks. */
  question?: MessageQuestion;
  /** Bot messages only: the bots this message proposes (a pending team card). */
  team?: TeamProposalItem[];
  /** The routine this message reports the result of (bot or system messages). */
  routineId?: string;
  /** User messages only: the routine the message is about (see `Message.routineRef`). */
  routineRef?: string;
  /** A part of a turn: see `Message.eventSeq`. */
  eventSeq?: number;
  /**
   * Whether the files the run sent that no message shows yet go with this message (default: yes
   * for a bot or system message of a run). A part posted in the middle of a run says `false`: the
   * files stay for the message that ends it.
   */
  attachFiles?: boolean;
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
  return (await appendMessageOnce(db, input)).message;
}

/** Like `appendMessage`, and says whether the message was written now or already existed (`dedupeKey`). */
export async function appendMessageOnce(
  db: Db,
  input: AppendMessageInput,
): Promise<{ message: Message; created: boolean }> {
  const m = appendSchema.parse(input);
  return withTransaction(db, async (tx) => {
    const [conv] = await tx.sql<{ archived_at: Date | null }[]>`
      select archived_at from conversations where id = ${m.conversationId} for no key update`;
    if (!conv) throw new ConversationNotFoundError(m.conversationId);
    if (conv.archived_at !== null) {
      throw new ConversationRuleError("Cannot add messages to an archived conversation");
    }
    if (m.dedupeKey !== undefined) {
      // The conversation row is locked: no other writer can insert this key until we commit.
      const [existing] = await tx.sql<MessageRow[]>`
        select ${tx.sql(MESSAGE_COLUMNS)} from messages
        where conversation_id = ${m.conversationId} and dedupe_key = ${m.dedupeKey}`;
      if (existing) return { message: mapMessage(existing), created: false };
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
    // The files the run sent that no message shows yet go with this one (a bot or system message
    // of the run), in the same transaction: whoever sees the message sees its files.
    const waiting =
      m.authorKind !== "user" && m.runId !== undefined && m.attachFiles !== false
        ? await tx.sql<{ id: string; name: string; mime: string; size: number }[]>`
            select id, name, mime, size from files
            where run_id = ${m.runId} and message_id is null
            order by created_at, id
            for update`
        : [];
    const attachments = waiting.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
    }));
    const [row] = await tx.sql<MessageRow[]>`
      insert into messages (conversation_id, seq, author_kind, author_bot_id, text, run_id, status, dedupe_key, question, team, routine_id, routine_ref, attachments, event_seq, created_at)
      values (
        ${m.conversationId},
        (select coalesce(max(seq), 0) + 1 from messages where conversation_id = ${m.conversationId}),
        ${m.authorKind},
        ${m.authorBotId ?? null},
        ${m.text},
        ${m.runId ?? null},
        ${m.status ?? null},
        ${m.dedupeKey ?? null},
        ${m.question === undefined ? null : tx.sql.json(m.question)},
        ${m.team === undefined ? null : tx.sql.json({ items: m.team, status: "pending", created: [] })},
        ${m.routineId ?? null},
        ${m.routineRef ?? null},
        ${attachments.length === 0 ? null : tx.sql.json(attachments)},
        ${m.eventSeq ?? null},
        clock_timestamp()
      )
      returning ${tx.sql(MESSAGE_COLUMNS)}`;
    if (!row) throw new Error("insert into messages returned no row");
    if (attachments.length > 0) {
      await tx.sql`
        update files set message_id = ${row.id}
        where id = any(${attachments.map((a) => a.id)}::uuid[])`;
    }
    await tx.sql`
      update conversations set last_message_at = ${row.created_at} where id = ${m.conversationId}`;
    return { message: mapMessage(row), created: true };
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
  /** `all` (default): every word. `any`: at least one (`suup_search_query_any`, migration 0018). */
  match?: "all" | "any";
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
 * Full-text search (Portuguese: stemming and stop words, so "provas" finds "prova"; accent-insensitive
 * where the database has the `unaccent` extension, see migration 0007) over messages,
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
    with q as (select ${opts.match === "any" ? sql`suup_search_query_any(${query})` : sql`suup_search_query(${query})`} as tsq)
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

/** Every word first; only when that finds nothing, any word (`broader: true`). */
export async function searchMessagesBroadening(
  db: Db,
  opts: Omit<SearchMessagesOptions, "match">,
): Promise<{ hits: MessageSearchHit[]; broader: boolean }> {
  const strict = await searchMessages(db, { ...opts, match: "all" });
  if (strict.length > 0) return { hits: strict, broader: false };
  const hits = await searchMessages(db, { ...opts, match: "any" });
  return { hits, broader: hits.length > 0 };
}
