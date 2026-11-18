/** The command line was wrong (exit code 2). The message says what and points to the help. */
export class UsageError extends Error {
  override readonly name = "UsageError";
  constructor(
    message: string,
    /** The command whose help to point to, e.g. "bot create". */
    readonly command?: string,
  ) {
    super(message);
  }
}

/** The command ran and could not do what was asked (exit code 1). The message is for the user. */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
