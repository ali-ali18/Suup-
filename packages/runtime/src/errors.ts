/** A problem with the configuration file: it is missing, unreadable, not JSON, or not valid. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    /** One entry per problem, already in plain Portuguese (what the CLI prints as a list). */
    readonly issues: readonly string[] = [],
    readonly path?: string,
  ) {
    super(message);
  }
}

export type RuntimeErrorCode =
  | "no_database_url"
  | "unknown_provider"
  | "unknown_model"
  | "model_provider_mismatch"
  | "bot_not_found"
  | "bot_archived"
  | "invalid_bot_id"
  | "sandbox_failed"
  | "empty_message"
  | "conversation_not_found"
  | "conversation_unsupported"
  | "draft_failed";

/**
 * Something the configuration or the registered data does not allow (a bot whose model is not in
 * the configuration, a run for an archived bot, ...). The message is in Portuguese and names what
 * is wrong, because the CLI prints it as it is.
 */
export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}
