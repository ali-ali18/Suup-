import { z } from "zod";
import { boolQuery, intQuery, isoDate, list, uuid } from "./common.js";
import { runSchema } from "./runs.js";

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
