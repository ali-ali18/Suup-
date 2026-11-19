import { z } from "zod";
import { boolQuery, csvQuery, intQuery, isoDate, list, uuid } from "./common.js";
import { messageSchema } from "./conversations.js";

export const MEMORY_LAYERS = ["rule", "profile", "note", "journal"] as const;
export const memoryLayerSchema = z.enum(MEMORY_LAYERS);
export type MemoryLayer = z.infer<typeof memoryLayerSchema>;
export const MEMORY_SCOPES = ["shared", "bot"] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);

export const MEMORY_STATUSES = ["active", "pending", "rejected"] as const;
/**
 * `active` counts (rules and the profile enter every prompt). `pending` waits for you: a rule or a
 * fact about you that a bot or the background consolidation proposed; it never enters a prompt
 * until you confirm it (`POST /v1/memories/:id/confirm`). `rejected` is what you refused.
 */
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

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
  /**
   * The state (see `memoryStatusSchema`). The server always sends it; it is optional here only so
   * that code that builds a `Memory` by hand keeps compiling. Absent means `active`.
   */
  status: memoryStatusSchema.optional(),
  /** The fact in one short line (at most 200 characters) of a note or a journal entry. */
  summary: z.string().nullable().optional(),
  /** The last time the bot found it with `recall` (notes and the journal expire when unused). */
  lastUsedAt: isoDate.nullable().optional(),
  /** A pending memory that proposes to replace this one: confirming it archives the other. */
  supersedesId: uuid.nullable().optional(),
  /**
   * Only on a pending memory a bot wrote after reading content from outside: what the reviewer
   * model said about it, so the card can show why it waits.
   */
  review: z.object({ decision: z.string(), reason: z.string() }).nullable().optional(),
});
export type Memory = z.infer<typeof memorySchema>;

export const listMemoriesQuerySchema = z.object({
  layer: memoryLayerSchema.optional(),
  scope: memoryScopeSchema.optional(),
  /** Only what belongs to this bot (its own notes, diary and rules), not the shared ones. */
  botId: uuid.optional(),
  includeArchived: boolQuery.optional(),
  /** Default `active`. `pending`: what waits for your confirmation. */
  status: memoryStatusSchema.optional(),
  limit: intQuery(1, 1000).default(500),
});
export type ListMemoriesQuery = {
  layer?: MemoryLayer;
  scope?: "shared" | "bot";
  botId?: string;
  includeArchived?: boolean;
  status?: MemoryStatus;
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

// ---- history of changes ------------------------------------------------------------------

export const REVISION_ACTORS = ["user", "bot", "consolidation", "expiry"] as const;
export const revisionActorSchema = z.enum(REVISION_ACTORS);
export const REVISION_KINDS = [
  "created",
  "edited",
  "confirmed",
  "rejected",
  "archived",
  "restored",
  "promoted",
  "undone",
] as const;

const memoryStateSchema = z.object({
  text: z.string(),
  summary: z.string().nullable(),
  status: memoryStatusSchema,
  layer: memoryLayerSchema,
  scope: memoryScopeSchema,
  botId: uuid.nullable(),
  archived: z.boolean(),
});

/**
 * One change of a memory: who made it (`actor`: you, the bot, the background consolidation or the
 * expiry), from where, what it was before (`null` for the creation) and what it became.
 */
export const memoryRevisionSchema = z.object({
  id: uuid,
  memoryId: uuid,
  kind: z.enum(REVISION_KINDS),
  actor: revisionActorSchema,
  prev: memoryStateSchema.nullable(),
  next: memoryStateSchema,
  originRunId: uuid.nullable(),
  originConversationId: uuid.nullable(),
  originMessageId: uuid.nullable(),
  originConsolidationId: uuid.nullable(),
  createdAt: isoDate,
});
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;
export const memoryRevisionListSchema = list(memoryRevisionSchema);

// ---- settings ----------------------------------------------------------------------------

/** The ranges of the memory settings, as the app should offer them. */
export const MEMORY_SETTING_LIMITS = {
  idleMinutes: { min: 1, max: 120 },
  maxTurns: { min: 3, max: 100 },
  promptLimitChars: { min: 1000, max: 50_000 },
  expiryDays: { min: 7, max: 3650 },
  compactionThreshold: { min: 0.5, max: 0.95 },
} as const;

/**
 * What the user controls about the memory (`GET`/`PATCH /v1/memory-settings`), plus two facts the
 * app should show: whether the background consolidation can really run, and which bots have more
 * always-loaded memory than `promptLimitChars` (so the app can ask to trim).
 */
export const memorySettingsSchema = z.object({
  consolidation: z.object({
    /** Master switch of the background consolidation. */
    enabled: z.boolean(),
    /** A conversation quiet for this long, with new user turns, is consolidated. 1 to 120. */
    idleMinutes: z.number().int(),
    /** ...or when this many user turns piled up since the last consolidation. 3 to 100. */
    maxTurns: z.number().int(),
  }),
  /** The most characters of ACTIVE rules and profile that go into every prompt. 1000 to 50000. */
  promptLimitChars: z.number().int(),
  /** Notes and journal entries not used for this many days are archived (restorable). 7 to 3650; `null`: never. */
  expiryDays: z.number().int().nullable(),
  /** Compact the chat history past this share of the context window. 0.5 to 0.95. */
  compactionThreshold: z.number(),
  /** Whether the consolidation (and the review of what a bot writes) has a model to use now. */
  reviewer: z.object({
    available: z.boolean(),
    model: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  promptUsage: z.object({
    limitChars: z.number().int(),
    /** Characters of the active shared rules and profile (every bot loads them). */
    sharedChars: z.number().int(),
    /** Bots whose always-loaded memory does not fit: the app should ask you to trim it. */
    overLimit: z.array(z.object({ botId: uuid, name: z.string(), usedChars: z.number().int() })),
  }),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

const L = MEMORY_SETTING_LIMITS;
// The server writes the path of the field before each message ("consolidation.maxTurns: ..."), so a
// message here only says what is wrong with the value, in words for the person.
const whole = (min: number, max: number) =>
  z.number().superRefine((n, ctx) => {
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({
        code: "custom",
        message: `deve ser um número inteiro entre ${min} e ${max}`,
      });
    }
  });

/** Only the keys you send change. Any other key is refused. */
export const updateMemorySettingsBodySchema = z.strictObject({
  consolidation: z
    .strictObject({
      enabled: z.boolean().optional(),
      idleMinutes: whole(L.idleMinutes.min, L.idleMinutes.max).optional(),
      maxTurns: whole(L.maxTurns.min, L.maxTurns.max).optional(),
    })
    .optional(),
  promptLimitChars: whole(L.promptLimitChars.min, L.promptLimitChars.max).optional(),
  expiryDays: z
    .number()
    .nullable()
    .superRefine((n, ctx) => {
      if (n !== null && (!Number.isInteger(n) || n < L.expiryDays.min || n > L.expiryDays.max)) {
        ctx.addIssue({
          code: "custom",
          message: `deve ser um número inteiro entre ${L.expiryDays.min} e ${L.expiryDays.max}, ou null para nunca expirar`,
        });
      }
    })
    .optional(),
  compactionThreshold: z
    .number()
    .superRefine((n, ctx) => {
      if (n < L.compactionThreshold.min || n > L.compactionThreshold.max) {
        ctx.addIssue({
          code: "custom",
          message: `deve ser um número entre ${L.compactionThreshold.min} e ${L.compactionThreshold.max}`,
        });
      }
    })
    .optional(),
});
export type UpdateMemorySettingsBody = z.input<typeof updateMemorySettingsBodySchema>;

// ---- consolidations ----------------------------------------------------------------------

/**
 * One attempt of the background consolidation: what was asked, which model, what it cost, what it
 * proposed and what the code kept or dropped (and why). Read-only.
 */
export const memoryConsolidationSchema = z.object({
  id: uuid,
  conversationId: uuid,
  botId: uuid,
  reason: z.enum(["idle", "max_turns", "pre_compaction"]),
  status: z.enum(["queued", "running", "done", "skipped", "failed"]),
  fromSeq: z.number().int().nullable(),
  toSeq: z.number().int().nullable(),
  userTurns: z.number().int().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  latencyMs: z.number().int().nullable(),
  proposed: z.unknown(),
  kept: z.unknown(),
  dropped: z.unknown(),
  error: z.string().nullable(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type MemoryConsolidation = z.infer<typeof memoryConsolidationSchema>;
export const memoryConsolidationListSchema = list(memoryConsolidationSchema);

export const listMemoryConsolidationsQuerySchema = z.object({
  conversationId: uuid.optional(),
  limit: intQuery(1, 200).default(50),
});
export type ListMemoryConsolidationsQuery = { conversationId?: string; limit?: number };
