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
  /** The sites the secret may be sent to (the owner declared them). */
  hosts: z.array(z.string()),
  /** No site declared: the secret cannot be used anywhere until the owner says where it may go. */
  blocked: z.boolean(),
});
export type Secret = z.infer<typeof secretSchema>;
export const secretListSchema = z.object({ items: z.array(secretSchema) });

/**
 * Whether the server can store secrets: the `vault` section is in its configuration and the master
 * key is present and valid. `reason` says what is missing, in Portuguese. Writes answer `503` when
 * `ok` is false; the list works either way.
 */
export const vaultStatusSchema = z.object({
  configured: z.boolean(),
  ok: z.boolean(),
  /** The NAME of the environment variable that holds the key (never the key). */
  keyEnv: z.string().nullable(),
  reason: z.string(),
});
export type VaultStatus = z.infer<typeof vaultStatusSchema>;

export const setSecretBodySchema = z.object({
  /** The value. At least 8 characters. It is never returned. */
  value: z.string().min(8).max(16_384),
  description: z.string().max(500).optional(),
  /** Bots to let use it right away. */
  grantBotIds: z.array(uuid).max(50).optional(),
  /**
   * The sites this secret may be sent to: plain DNS names (`api.exemplo.com`), no scheme, port, path,
   * wildcard or IP address. Omitted: a new secret stays blocked, and an existing one keeps its sites.
   */
  hosts: z.array(z.string().min(1).max(253)).max(20).optional(),
});
export type SetSecretBody = z.input<typeof setSecretBodySchema>;

/** The question a bot asked the user ("I need the token of ..."), while its run waits. */
export const secretRequestSchema = z.object({
  runId: uuid,
  botId: uuid,
  name: z.string(),
  /** What the bot says it is for. */
  reason: z.string().nullable(),
  /** The sites the bot SUGGESTS (the form shows them to confirm or change). */
  hosts: z.array(z.string()),
});
export type SecretRequest = z.infer<typeof secretRequestSchema>;

/** The answer: the value (which goes straight to the vault) or a refusal. */
export const answerSecretRequestBodySchema = z.object({
  value: z.string().min(8).max(16_384).optional(),
  declined: z.boolean().optional(),
  description: z.string().max(500).optional(),
  /** The sites the USER confirmed (at least one with a value): what the vault keeps, never the bot's word. */
  hosts: z.array(z.string().min(1).max(253)).max(20).optional(),
});
export type AnswerSecretRequestBody = z.input<typeof answerSecretRequestBodySchema>;

export const answerSecretRequestResultSchema = z.object({
  name: z.string(),
  /** `false` when the user declined. */
  provided: z.boolean(),
});
export type AnswerSecretRequestResult = z.infer<typeof answerSecretRequestResultSchema>;

/**
 * The credential of a plugin (the key of a search engine, the token of a gallery connector): it is
 * kept WITH the plugin, outside the owner's vault, and never granted to a bot. Write-only, like a
 * secret: the value goes in and nothing in the API brings it back.
 */
/** Replaces the sites a secret may be sent to (empty: blocked). */
export const setSecretHostsBodySchema = z.object({
  hosts: z.array(z.string().min(1).max(253)).max(20),
});
export type SetSecretHostsBody = z.input<typeof setSecretHostsBodySchema>;

export const setPluginCredentialBodySchema = z.object({
  /** The key or token. At least 8 characters. It is never returned. */
  value: z.string().min(8).max(16_384),
});
export type SetPluginCredentialBody = z.input<typeof setPluginCredentialBodySchema>;

export const pluginCredentialStoredSchema = z.object({ stored: z.literal(true) });
