import { z } from "zod";
import { isoDate, uuid } from "./common.js";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const secretNameSchema = z
  .string()
  .regex(SECRET_NAME, "use letras maiúsculas, números e sublinhado, começando por letra");

/**
 * A secret as the API shows it: its name and metadata. There is no field for the value and no
 * route that returns it: the value can be written and replaced, never read back.
 */
export const secretSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** A fingerprint of the master key that encrypted it (not the key). */
  keyId: z.string(),
  /** The bots that may use it. */
  grantedBotIds: z.array(uuid),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastUsedAt: isoDate.nullable(),
});
export type Secret = z.infer<typeof secretSchema>;
export const secretListSchema = z.object({ items: z.array(secretSchema) });

export const setSecretBodySchema = z.object({
  /** The value. At least 8 characters. It is never returned. */
  value: z.string().min(8).max(16_384),
  description: z.string().max(500).optional(),
  /** Bots to let use it right away. */
  grantBotIds: z.array(uuid).max(50).optional(),
});
export type SetSecretBody = z.input<typeof setSecretBodySchema>;

/** The question a bot asked the user ("I need the token of ..."), while its run waits. */
export const secretRequestSchema = z.object({
  runId: uuid,
  botId: uuid,
  name: z.string(),
  /** What the bot says it is for. */
  reason: z.string().nullable(),
});
export type SecretRequest = z.infer<typeof secretRequestSchema>;

/** The answer: the value (which goes straight to the vault) or a refusal. */
export const answerSecretRequestBodySchema = z.object({
  value: z.string().min(8).max(16_384).optional(),
  declined: z.boolean().optional(),
  description: z.string().max(500).optional(),
});
export type AnswerSecretRequestBody = z.input<typeof answerSecretRequestBodySchema>;

export const answerSecretRequestResultSchema = z.object({
  name: z.string(),
  /** `false` when the user declined. */
  provided: z.boolean(),
});
export type AnswerSecretRequestResult = z.infer<typeof answerSecretRequestResultSchema>;
