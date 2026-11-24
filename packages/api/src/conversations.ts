import { z } from "zod";
import { botColorSchema, botSchema } from "./bots.js";
import { boolQuery, intQuery, isoDate, list, uuid } from "./common.js";
import { FILE_KINDS } from "./files.js";
import { runSchema } from "./runs.js";

/** A choice offered with a question. The answer is still plain text: the label, or free text. */
export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.exactOptional(z.string()),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** One question of what the bot asked: free text, or a choice among options. */
export const questionSchema = z.object({
  question: z.string(),
  /** 2 to 6 choices when the answers are discrete; absent for an open question. */
  options: z.exactOptional(z.array(questionOptionSchema)),
  /** The user may pick several options. */
  multiple: z.exactOptional(z.boolean()),
  /** The user may answer with something that is not in the list. */
  allowOther: z.exactOptional(z.boolean()),
});
export type Question = z.infer<typeof questionSchema>;

/** The structured side of a bot message that asks the user something: ONE shape for every case. */
export const messageQuestionSchema = z.object({
  /** What was asked: one question (the usual case) or a questionnaire of up to 5. */
  questions: z.array(questionSchema).min(1),
  /** `review_tie_break`: the reviewer rejected too often and the user must decide. */
  reason: z.exactOptional(z.literal("review_tie_break")),
  /**
   * What the bot wrote besides the question, in the same turn: the chat draws it as the bot's
   * bubble above the card. Absent when the bot only asked (the card's title is the question).
   */
  lead: z.exactOptional(z.string()),
});
export type MessageQuestion = z.infer<typeof messageQuestionSchema>;

/** One bot proposed on a team card: the draft of the app, for the user to tick. */
export const teamProposalItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  personality: z.string(),
});
export type TeamProposalItem = z.infer<typeof teamProposalItemSchema>;

/**
 * The team card of a bot message (the main bot's welcome): up to 3 proposed bots and what the user
 * decided. `pending` waits for the user; `created` says which proposals became bots (`created`:
 * their position and id); `dismissed` is "Agora não". Only the user's decision creates anything.
 */
export const teamProposalSchema = z.object({
  items: z.array(teamProposalItemSchema).min(1),
  status: z.enum(["pending", "created", "dismissed"]),
  created: z.array(z.object({ index: z.number().int().min(0), botId: uuid })),
});
export type TeamProposal = z.infer<typeof teamProposalSchema>;

/**
 * A file a bot message carries (`send_file`): what the chat draws (`kind` picks the icon, from the
 * MIME type by an exact table) and what `GET /v1/files/:id` downloads.
 */
export const messageAttachmentSchema = z.object({
  id: uuid,
  name: z.string(),
  mime: z.string(),
  /** Bytes. */
  size: z.number().int().nonnegative(),
  kind: z.enum(FILE_KINDS),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const messageSchema = z.object({
  id: uuid,
  conversationId: uuid,
  /** Position in the conversation: 1, 2, 3... with no gaps. */
  seq: z.number().int(),
  authorKind: z.enum(["user", "bot", "system"]),
  authorBotId: uuid.nullable(),
  text: z.string(),
  /** The run the message opened (yours) or that produced it (the bot's). */
  runId: uuid.nullable(),
  /**
   * Yours, sent while the bot worked: `sent` until the bot reads it, then `delivered`.
   * `null` for everything else.
   */
  status: z.enum(["sent", "delivered"]).nullable(),
  createdAt: isoDate,
  /** Only on the bot message that asks the user something (an `escalate`): see `MessageQuestion`. */
  question: z.exactOptional(messageQuestionSchema),
  /** Only on the bot message that proposes a team of bots (the card with the ticks). */
  team: z.exactOptional(teamProposalSchema),
  /** Only on the message that reports a routine's run: the routine (docs/ROTINAS.md). */
  routineId: z.exactOptional(uuid),
  /**
   * Only on a message of yours that is about a routine (the app's "Editar"): which one. It is data
   * of the message, never part of `text`; the bot is told which routine it is.
   */
  routineRef: z.exactOptional(z.object({ id: uuid })),
  /** Only on a bot (or system) message whose run sent files: the files, oldest first. */
  attachments: z.exactOptional(z.array(messageAttachmentSchema)),
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: uuid,
  kind: z.enum(["direct", "group"]),
  title: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastMessageAt: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  members: z.array(
    z.object({
      botId: uuid,
      name: z.string(),
      avatar: z.string().nullable(),
      joinedAt: isoDate,
    }),
  ),
  /** The last message, cut to its first 200 characters. */
  lastMessage: z
    .object({
      id: uuid,
      seq: z.number().int(),
      authorKind: z.enum(["user", "bot", "system"]),
      authorBotId: uuid.nullable(),
      text: z.string(),
      createdAt: isoDate,
    })
    .nullable(),
  /** Read up to this message `seq`. */
  lastReadSeq: z.number().int(),
  unreadCount: z.number().int(),
  /** The run that is working on the conversation now (or waiting for you), if any. */
  activeRun: runSchema.nullable(),
  /**
   * The welcome of the bot of this conversation (docs/RECEPCAO.md): `pending` not started,
   * `started` its run was opened, `done` over (or never due), `redo` the user asked to do it again.
   */
  reception: z.enum(["pending", "started", "done", "redo"]),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const listConversationsQuerySchema = z.object({
  includeArchived: boolQuery.optional(),
  limit: intQuery(1, 200).default(100),
});
export type ListConversationsQuery = { includeArchived?: boolean; limit?: number };
export const conversationListSchema = list(conversationSchema);

export const listMessagesQuerySchema = z.object({
  /** Messages before this `seq` (scrolling up). */
  before: intQuery(1, Number.MAX_SAFE_INTEGER).optional(),
  /** Messages after this `seq` (catching up). */
  after: intQuery(0, Number.MAX_SAFE_INTEGER).optional(),
  limit: intQuery(1, 200).default(50),
});
export type ListMessagesQuery = { before?: number; after?: number; limit?: number };
/**
 * A page of messages in ascending `seq`. Without a cursor: the newest ones. `hasMore`: there are
 * more in the direction asked (older ones for no cursor and `before`, newer ones for `after`).
 */
export const messagePageSchema = z.object({ items: z.array(messageSchema), hasMore: z.boolean() });

export const sendMessageBodySchema = z.object({
  text: z
    .string()
    .refine((t) => t.trim().length > 0, "a mensagem está vazia")
    .pipe(z.string().max(100_000)),
  /**
   * The routine the message is about (the app's "Editar" binds it to the draft): a routine of the
   * conversation's bot. Stored with the message, never added to its text; the bot reads which
   * routine it is in a note of the harness and changes that one.
   */
  routineRef: z.exactOptional(z.object({ id: uuid })),
});
export type SendMessageBody = z.input<typeof sendMessageBodySchema>;
export const sendMessageResultSchema = z.object({
  message: messageSchema,
  /** The run that holds the message: the one it opened, or the one that was already working. */
  run: runSchema,
  /** The message went to a run that was already active (`message.status` is `sent`). */
  queuedForRun: z.boolean(),
});
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;

export const markReadBodySchema = z.object({
  /** Read up to this `seq`. Default: everything. */
  upToSeq: z.number().int().min(0).optional(),
});
export type MarkReadBody = z.input<typeof markReadBodySchema>;

/** `POST /v1/bots/{id}/reception`: the open of a bot's chat asks for its welcome. */
export const receptionResultSchema = z.object({
  /** The direct conversation of the bot (created at the first call). */
  conversationId: uuid,
  /** THIS call started the welcome: its run is `runId`. False when it already ran or is not due. */
  started: z.boolean(),
  runId: uuid.nullable(),
});
export type ReceptionResult = z.infer<typeof receptionResultSchema>;

/**
 * `POST /v1/messages/{id}/team`: the user's decision on a team card: the positions they ticked (each
 * with the mascot and colour the card showed, so the bot is born looking the same), or "Agora não".
 */
export const decideTeamBodySchema = z.union([
  z.object({ dismiss: z.literal(true) }),
  z.object({
    create: z
      .array(
        z.object({
          index: z.number().int().min(0),
          avatar: z.string().min(1).max(200).optional(),
          color: botColorSchema.optional(),
        }),
      )
      .min(1)
      .max(5),
  }),
]);
export type DecideTeamBody = z.input<typeof decideTeamBodySchema>;
export const decideTeamResultSchema = z.object({
  message: messageSchema,
  /** The bots created now (none for "Agora não"). */
  bots: z.array(botSchema),
});
export type DecideTeamResult = z.infer<typeof decideTeamResultSchema>;
