/** Used by `exec` when the caller gives no `timeoutMs`, so a forgotten limit cannot hang a run. */
export const DEFAULT_EXEC_TIMEOUT_MS = 300_000;

/** Cap on captured stdout and, separately, stderr of one `exec` call: 1 MiB each. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Largest file `readFile` returns: 32 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 33_554_432;

/** A file larger than a caller's limit (`readFileBytes`). `size` is `null` when not known. */
export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";
  readonly limit: number;
  readonly size: number | null;
  constructor(path: string, size: number | null, limit: number) {
    super(
      `file too large (${size === null ? "more than" : `${size} bytes,`} limit ${limit} bytes): ${path}`,
    );
    this.size = size;
    this.limit = limit;
  }
}
