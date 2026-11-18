import { z } from "zod";
import { boolQuery, isoDate, list, uuid } from "./common.js";
import { runStatusSchema } from "./runs.js";

export const botLimitsSchema = z.looseObject({
  maxTurns: z.exactOptional(z.number().int().positive()),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(z.number().int().positive()),
});
export type BotLimits = z.infer<typeof botLimitsSchema>;

/** A bot, as the list screen shows it. */
export const botSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  modelProvider: z.string(),
  modelId: z.string(),
  allowedTools: z.array(z.string()),
  limits: botLimitsSchema,
  /** An opaque reference the app reads (an emoji, a file id...). */
  avatar: z.string().nullable(),
  /** The main bot: it receives the messages when none is chosen. */
  isDefault: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: isoDate.nullable(),
  /** The bot's most recent run (any origin), or `null` when it never ran. */
  latestRun: z
    .object({
      id: uuid,
      status: runStatusSchema,
      paused: z.boolean(),
      objective: z.string(),
      createdAt: isoDate,
    })
    .nullable(),
  /** The bot's direct conversation, or `null` before the first message. */
  conversationId: uuid.nullable(),
  /** Messages from the bot (or the system) the user has not read yet. */
  unreadCount: z.number().int(),
});
export type Bot = z.infer<typeof botSchema>;

export const listBotsQuerySchema = z.object({ includeArchived: boolQuery.optional() });
export type ListBotsQuery = { includeArchived?: boolean };
export const botListSchema = list(botSchema);

const nameField = z.string().trim().min(1).max(60);
export const createBotBodySchema = z.object({
  name: nameField,
  description: z.exactOptional(z.string().max(400)),
  personality: z.exactOptional(z.string().max(20_000)),
  /** An `id` from `GET /v1/models`. The provider follows from it. */
  modelId: z.string().min(1),
  /** Names from `GET /v1/tools`. Default: none (the control tools are always there). */
  allowedTools: z.exactOptional(z.array(z.string())),
  limits: z.exactOptional(botLimitsSchema),
  avatar: z.exactOptional(z.string().min(1).max(2048).nullable()),
});
export type CreateBotBody = z.input<typeof createBotBodySchema>;

export const updateBotBodySchema = createBotBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "informe pelo menos um campo para alterar");
export type UpdateBotBody = z.input<typeof updateBotBodySchema>;

export const draftBotBodySchema = z.object({
  /** What the user wants the bot to be, in free text. */
  description: z.string().trim().min(1).max(4000),
  /** The model that writes the proposal. Default: the default bot's model, else the first model. */
  modelId: z.exactOptional(z.string().min(1)),
});
export type DraftBotBody = z.input<typeof draftBotBodySchema>;
export const botDraftSchema = z.object({
  name: z.string(),
  description: z.string(),
  personality: z.string(),
});
export type BotDraft = z.infer<typeof botDraftSchema>;

/** A model the bots can use, and whether it can be used right now. */
export const modelInfoSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerKind: z.enum(["anthropic", "openai-compatible", "scripted"]),
  contextWindow: z.number().int(),
  maxOutputTokens: z.number().int(),
  /** The configuration has prices for it (the cost of a run is only counted then). */
  priced: z.boolean(),
  /** The provider has what it needs (an API key in the server's environment). */
  available: z.boolean(),
  /** Why it is not available, in Portuguese; `null` when it is. */
  unavailableReason: z.string().nullable(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export const modelListSchema = list(modelInfoSchema);

export const toolInfoSchema = z.object({
  name: z.string(),
  /** The first sentence of what the model is told about the tool. */
  summary: z.string(),
  risk: z.enum(["read", "write", "external"]),
  /** One of the memory tools. */
  memory: z.boolean(),
});
export type ToolInfo = z.infer<typeof toolInfoSchema>;
export const toolListSchema = z.object({
  items: z.array(toolInfoSchema),
  /** The tools every bot has whatever `allowedTools` says. */
  control: z.array(z.string()),
});
