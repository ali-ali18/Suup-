import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** How long to wait for the output pipes to close after the process exited. */
const PIPE_GRACE_MS = 500;
/** Upper bound for the `onTerminate` hook, so a stuck cleanup cannot hang the caller. */
const TERMINATE_HOOK_LIMIT_MS = 15_000;

export interface RunProcessOptions {
  cwd?: string;
  /** The COMPLETE environment of the child. Nothing is inherited from the current process. */
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed. Without it, stdin is `/dev/null`. */
  input?: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per stream. Bytes beyond it are read and discarded so the child never blocks on a full pipe. */
  maxOutputBytes: number;
  /**
   * Start the child in its own process group and, on timeout or abort, SIGKILL the whole group
   * (so grandchildren such as a `sleep` started by the shell die too).
   */
  killGroup: boolean;
  /** Extra cleanup on timeout or abort, e.g. killing the processes inside a container. */
  onTerminate?: () => Promise<void>;
}

export interface RunProcessResult {
  /** `null` when the process was killed by a signal or could not be started. */
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be spawned at all (missing binary, bad cwd). */
  spawnError?: Error;
  elapsedMs: number;
}

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  push(chunk: Buffer): void {
    const room = this.#max - this.#bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes += room;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
  }

  get buffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/**
 * Runs a binary (no shell involved on this side) and collects its output with a hard cap.
 * Never rejects: failures are reported in the result.
 */
export function runProcess(
  file: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const startedAt = Date.now();
  const empty = (extra: Partial<RunProcessResult>): RunProcessResult => ({
    exitCode: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    elapsedMs: Date.now() - startedAt,
    ...extra,
  });

  if (options.signal?.aborted) return Promise.resolve(empty({ aborted: true }));

  return new Promise<RunProcessResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        detached: options.killGroup,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(empty({ spawnError: toError(error) }));
      return;
    }

    const out = new Capture(options.maxOutputBytes);
    const err = new Capture(options.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when the child exits before reading it all
      child.stdin.end(options.input);
    }

    let exitCode: number | null = null;
    let spawnError: Error | undefined;
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let settled = false;
    let hook: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (): void => {
      if (exited || settled) return;
      if (options.killGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // the group is already gone
        }
      }
      child.kill("SIGKILL");
      if (options.onTerminate !== undefined && hook === undefined) {
        hook = options.onTerminate().catch(() => {});
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const hookDone =
        hook === undefined
          ? Promise.resolve()
          : Promise.race([hook, new Promise<void>((r) => setTimeout(r, TERMINATE_HOOK_LIMIT_MS))]);
      void hookDone.then(() =>
        resolve({
          exitCode,
          stdout: out.buffer,
          stderr: err.buffer,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          timedOut,
          aborted,
          ...(spawnError === undefined ? {} : { spawnError }),
          elapsedMs: Date.now() - startedAt,
        }),
      );
    };

    child.on("error", (error) => {
      spawnError = error;
      exited = true;
      finish();
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = timedOut || aborted ? null : code;
      // A background process that inherited the pipes would keep them open forever.
      graceTimer = setTimeout(finish, PIPE_GRACE_MS);
    });
    child.on("close", finish);
  });
}

/** Decodes captured bytes as UTF-8, dropping a multi-byte character cut in half by the cap. */
export function decodeCaptured(bytes: Buffer, truncated: boolean, limit: number): string {
  const text = new StringDecoder("utf8").write(bytes);
  return truncated ? `${text}\n[... output truncated: more than ${limit} bytes ...]` : text;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
