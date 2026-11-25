import { z } from "zod";
import { boolQuery, isoDate, list, uuid } from "./common.js";
import { runStatusSchema } from "./runs.js";

/** The user's bubble text: white on every colour. */
const USER_BUBBLE_TEXT = "#ffffff";

/**
 * The closed palette a bot's mascot and conversation may be painted with, in the order the app
 * shows it (the owner's reference of 24/11/2026; amber keeps the id `amarelo`). The server stores
 * only these ids (never CSS). Every entry carries its colours:
 * - `fill` / `onFill`: the mascot's body (and the send button) and what is drawn on it; chosen so
 *   the contrast of `onFill` on `fill` is at least 4.5:1 (a test checks it; the app never computes
 *   colours);
 * - `userBubbleFill` / `userBubbleOnFill`: the user's bubble in a conversation with that bot. It is
 *   the bot's colour, except for the white bot: its bubble is a neutral grey. The text is white on
 *   every colour (owner's decision, 24/11/2026), so on the light colours (amber, turquoise, green...)
 *   it is below 4.5:1: the colours are not darkened to make up for it.
 */
export const BOT_PALETTE = {
  branco: {
    ...entry("branco", "#ffffff", "#0b0b0c"),
    userBubbleFill: "#3a3a3c",
  },
  marrom: entry("marrom", "#a3683e", "#ffffff"),
  vermelho: entry("vermelho", "#ff3347", "#0b0b0c"),
  laranja: entry("laranja", "#ff6a13", "#0b0b0c"),
  amarelo: entry("amarelo", "#ff9f0a", "#0b0b0c"),
  verde: entry("verde", "#12c46a", "#0b0b0c"),
  turquesa: entry("turquesa", "#13b8a6", "#0b0b0c"),
  azul: entry("azul", "#1a84ff", "#0b0b0c"),
  roxo: entry("roxo", "#9b5cf6", "#0b0b0c"),
  rosa: entry("rosa", "#ff3d97", "#0b0b0c"),
  cinza: entry("cinza", "#7c7c80", "#0b0b0c"),
} as const;

function entry<Id extends string>(id: Id, fill: string, onFill: string) {
  return { id, fill, onFill, userBubbleFill: fill, userBubbleOnFill: USER_BUBBLE_TEXT } as {
    id: Id;
    fill: string;
    onFill: string;
    userBubbleFill: string;
    userBubbleOnFill: string;
  };
}
export const BOT_COLORS = Object.keys(BOT_PALETTE) as [
  keyof typeof BOT_PALETTE,
  ...(keyof typeof BOT_PALETTE)[],
];
export const botColorSchema = z.enum(BOT_COLORS);
export type BotColor = z.infer<typeof botColorSchema>;

/** The two families of mascots: the engine's shapes, or the pixel ones drawn by the owner. */
export const AVATAR_STYLES = ["shapes", "pixel"] as const;
export const avatarStyleSchema = z.enum(AVATAR_STYLES);
export type AvatarStyle = z.infer<typeof avatarStyleSchema>;

const groupNameSchema = z
  .string()
  .transform((g) => g.trim())
  .pipe(z.string().min(1).max(60));

export const botLimitsSchema = z.looseObject({
  maxTurns: z.exactOptional(z.number().int().positive()),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(z.number().int().positive()),
  /** Consecutive returns the bot may schedule for itself (`schedule_return`); `0` turns them off. */
  maxReturns: z.exactOptional(z.number().int().nonnegative()),
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
  /** Pinned at the top of the list. (The defaults let the client read an older server.) */
  pinned: z.boolean().default(false),
  /** The group the bot is listed under; `null` for the default list ("Bots"). */
  groupName: z.string().nullable().default(null),
  /** Position inside its block (pinned, or its group); `null` sorts last. */
  sortOrder: z.number().int().nullable().default(null),
  /** One of `BOT_COLORS`, or `null`: the app then picks one from the bot's id. */
  color: botColorSchema.nullable().default(null),
  /** Which family of mascots `avatar` (`mascot:<id>`) names: the engine's shapes or the pixel ones. */
  avatarStyle: avatarStyleSchema.default("shapes"),
  /** Só com `avatarStyle: "pixel"`: o mascote é desenhado em 3D (padrão: 2D). */
  avatarPixel3d: z.boolean().default(false),
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
const botFieldsSchema = z.object({
  name: nameField,
  description: z.exactOptional(z.string().max(400)),
  personality: z.exactOptional(z.string().max(20_000)),
  /** An `id` from `GET /v1/models`. The provider follows from it. */
  modelId: z.string().min(1),
  /** Names from `GET /v1/tools`. Default: none (the control tools are always there). */
  allowedTools: z.exactOptional(z.array(z.string())),
  limits: z.exactOptional(botLimitsSchema),
  avatar: z.exactOptional(z.string().min(1).max(2048).nullable()),
  pinned: z.exactOptional(z.boolean()),
  groupName: z.exactOptional(groupNameSchema.nullable()),
  sortOrder: z.exactOptional(z.number().int().nullable()),
  color: z.exactOptional(botColorSchema.nullable()),
  avatarStyle: z.exactOptional(avatarStyleSchema),
  avatarPixel3d: z.exactOptional(z.boolean()),
});
export const createBotBodySchema = botFieldsSchema.extend({
  makeDefault: z.exactOptional(z.boolean()),
});
export type CreateBotBody = z.input<typeof createBotBodySchema>;

export const updateBotBodySchema = botFieldsSchema
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
  /** The short name to show (the configuration's `name`, or the id when it declares none). */
  name: z.string(),
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

/** `GET /v1/info`: what the server says about itself (read-only). */
export const serverInfoSchema = z.object({
  /**
   * The user's time zone (IANA name): what "now" and routines mean to the bots. `null` while nobody
   * said it (the app sends the zone of the user's computer when it connects): never the server's.
   */
  timeZone: z.string().nullable(),
  /** Where it came from: chosen by the user, sent by the app from the computer, or the configuration. */
  timeZoneSource: z.enum(["user", "device", "config"]).nullable(),
  /**
   * Where the browser comes back from the OAuth login of a connector: `loopback` (a listener on the
   * server's own computer: works when the browser runs there, the app on this computer) or `public`
   * (the server's public HTTPS address, `server.publicUrl`: works from anywhere).
   */
  oauthCallback: z.enum(["loopback", "public"]),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

export const toolInfoSchema = z.object({
  name: z.string(),
  /** The first sentence of what the model is told about the tool. */
  summary: z.string(),
  /**
   * The default level of a call: `read`, `write_reversible` or `external_irreversible`. A tool
   * with `dynamicRisk` classifies each call from its arguments (the level can differ per call).
   */
  risk: z.enum(["read", "write_reversible", "external_irreversible"]),
  dynamicRisk: z.boolean(),
  /** Some argument of the tool accepts a secret placeholder (`{{secret:NAME}}`). */
  acceptsSecrets: z.boolean(),
  /** Its output comes from outside and reaches the model labelled as untrusted data. */
  externalOutput: z.boolean(),
  /** One of the memory tools. */
  memory: z.boolean(),
});
export type ToolInfo = z.infer<typeof toolInfoSchema>;
export const toolListSchema = z.object({
  items: z.array(toolInfoSchema),
  /** The tools every bot has whatever `allowedTools` says. */
  control: z.array(z.string()),
});
