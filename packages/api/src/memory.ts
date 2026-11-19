import { z } from "zod";
import { boolQuery, csvQuery, intQuery, isoDate, list, uuid } from "./common.js";
import { messageSchema } from "./conversations.js";

export const MEMORY_LAYERS = ["rule", "profile", "note", "journal"] as const;
export const memoryLayerSchema = z.enum(MEMORY_LAYERS);
export type MemoryLayer = z.infer<typeof memoryLayerSchema>;
export const MEMORY_SCOPES = ["shared", "bot"] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);

export const memorySchema = z.object({
  id: uuid,
  layer: memoryLayerSchema,
  /** `shared` (every bot) or `bot` (one). A profile is always shared; notes and the diary never are. */
  scope: memoryScopeSchema,
  botId: uuid.nullable(),
  text: z.string(),
  /** Where it came from, when a bot saved it. */
  sourceConversationId: uuid.nullable(),
  sourceRunId: uuid.nullable(),
  sourceMessageId: uuid.nullable(),
  /** `user` (you) or `bot`. */
  createdBy: z.enum(["user", "bot"]),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** Forgotten memories are archived, not deleted: they can be restored. */
  archivedAt: isoDate.nullable(),
});
export type Memory = z.infer<typeof memorySchema>;

export const listMemoriesQuerySchema = z.object({
  layer: memoryLayerSchema.optional(),
  scope: memoryScopeSchema.optional(),
  /** Only what belongs to this bot (its own notes, diary and rules), not the shared ones. */
  botId: uuid.optional(),
  includeArchived: boolQuery.optional(),
  limit: intQuery(1, 1000).default(500),
});
export type ListMemoriesQuery = {
  layer?: MemoryLayer;
  scope?: "shared" | "bot";
  botId?: string;
  includeArchived?: boolean;
  limit?: number;
};
export const memoryListSchema = list(memorySchema);

/** The layers a person writes: the diary is written by the system, at the end of every run. */
export const WRITABLE_MEMORY_LAYERS = ["rule", "profile", "note"] as const;
export const addMemoryBodySchema = z.object({
  layer: z.enum(WRITABLE_MEMORY_LAYERS),
  text: z
    .string()
    .refine((t) => t.trim().length > 0, "o texto está vazio")
    .pipe(z.string().max(20_000)),
  /** Default by layer: profile shared, note and diary per bot, rule per bot when `botId` is given. */
  scope: memoryScopeSchema.optional(),
  /** Required for scope `bot`. */
  botId: uuid.optional(),
});
export type AddMemoryBody = z.input<typeof addMemoryBodySchema>;

export const editMemoryBodySchema = z.object({
  text: z
    .string()
    .refine((t) => t.trim().length > 0, "o texto está vazio")
    .pipe(z.string().max(20_000)),
});
export type EditMemoryBody = z.input<typeof editMemoryBodySchema>;

/** Where in `excerpt` the words that matched are (character offsets, `end` exclusive). */
const matchesSchema = z.array(z.object({ start: z.number().int(), end: z.number().int() }));

export const searchMemoriesQuerySchema = z.object({
  q: z.string().min(1).max(1000),
  /** The bot searching (it sees the shared memories and its own). Without it, only the shared ones. */
  botId: uuid.optional(),
  layers: csvQuery.pipe(z.array(memoryLayerSchema)).optional(),
  limit: intQuery(1, 100).default(20),
});
export type SearchMemoriesQuery = {
  q: string;
  botId?: string;
  layers?: MemoryLayer[];
  limit?: number;
};
export const memorySearchSchema = list(
  z.object({ memory: memorySchema, excerpt: z.string(), matches: matchesSchema, rank: z.number() }),
);

export const searchMessagesQuerySchema = z.object({
  q: z.string().min(1).max(1000),
  conversationId: uuid.optional(),
  botId: uuid.optional(),
  limit: intQuery(1, 100).default(20),
});
export type SearchMessagesQuery = {
  q: string;
  conversationId?: string;
  botId?: string;
  limit?: number;
};
export const messageSearchSchema = list(
  z.object({
    message: messageSchema,
    excerpt: z.string(),
    matches: matchesSchema,
    rank: z.number(),
  }),
);
