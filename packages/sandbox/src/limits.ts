/** Used by `exec` when the caller gives no `timeoutMs`, so a forgotten limit cannot hang a run. */
export const DEFAULT_EXEC_TIMEOUT_MS = 300_000;

/** Cap on captured stdout and, separately, stderr of one `exec` call: 1 MiB each. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Largest file `readFile` returns: 32 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 33_554_432;
