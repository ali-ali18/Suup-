/**
 * Quotes one argument for POSIX `sh` so that the shell passes it through unchanged: wrapped in
 * single quotes, with each embedded single quote written as `'\''`. Inside single quotes nothing
 * is special (no `$`, backticks, backslashes, globbing or newlines handling), so the result is
 * safe to splice into a command line.
 *
 * NUL bytes cannot be represented in a shell word and are rejected.
 */
export function shellQuote(arg: string): string {
  if (arg.includes("\0")) throw new Error("a shell argument cannot contain a NUL byte");
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Quotes and joins several arguments into one command line. */
export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}
