import { mkdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type FileStat,
  resolveWorkspacePath,
  WorkspaceEscapeError,
} from "@suup/core";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  FileTooLargeError,
} from "./limits.js";
import { decodeCaptured, runProcess } from "./run-process.js";

export interface LocalExecutorOptions {
  /** Directory that plays the role of the workspace. Created if missing. */
  root: string;
  /**
   * Must be literally `true`. `LocalExecutor` runs commands directly on THIS machine as THIS
   * user: there is no container, no resource limit and no network restriction. Passing the flag
   * is the caller acknowledging that.
   */
  iUnderstandThisIsNotIsolated: true;
  /** Cap per stream (stdout, stderr) of one `exec`. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Largest file `readFile` accepts. Default 32 MiB. */
  maxFileBytes?: number;
}

const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Runs commands and file operations directly on the host, inside the directory `root`.
 *
 * WARNING: FOR DEVELOPMENT AND TESTS ONLY. THIS IS NOT A SANDBOX.
 *
 * - A command is a normal host process: it can read, write and delete anything the current user
 *   can, and use the network freely. Only the working directory is `root`.
 * - What IS enforced: the file methods (`readFile`, `writeFile`, `listDir`, `stat`) and `cwd`
 *   refuse paths that leave `root`, including through symlinks. That is a guard against bugs in
 *   tools, not a security boundary: a shell command can create or follow any link it likes, and
 *   the symlink check is not atomic (a link swapped between check and use wins).
 * - Commands get a minimal clean environment (PATH, HOME=root, LANG, TERM) plus `opts.env`; the
 *   environment of the server process is NOT inherited, since it may hold secrets.
 * - Timeouts and aborts SIGKILL the whole process group of the command.
 * - stdout and stderr are each capped (default 1 MiB, the rest is read and dropped).
 *
 * Use `DockerExecutor` for anything that runs model-chosen commands for real.
 */
export class LocalExecutor implements Executor {
  /** The commands run directly on this computer: nothing isolates them. */
  readonly isolated = false;
  readonly root: string;
  readonly #maxOutputBytes: number;
  readonly #maxFileBytes: number;

  constructor(options: LocalExecutorOptions) {
    if ((options.iUnderstandThisIsNotIsolated as unknown) !== true) {
      throw new Error(
        "LocalExecutor provides NO isolation; pass iUnderstandThisIsNotIsolated: true to use it (development and tests only)",
      );
    }
    this.root = resolve(options.root);
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    mkdirSync(this.root, { recursive: true });
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = await this.#resolve(opts.cwd ?? ".");
    const cwdStat = await stat(cwd).catch(() => null);
    if (cwdStat === null || !cwdStat.isDirectory()) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `suup: working directory not found: ${opts.cwd ?? "."}\n`,
        timedOut: false,
      };
    }

    const result = await runProcess("/bin/sh", ["-c", command], {
      cwd,
      env: { PATH: BASE_PATH, HOME: this.root, LANG: "C.UTF-8", TERM: "dumb", ...opts.env },
      timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      maxOutputBytes: this.#maxOutputBytes,
      killGroup: true,
    });
    if (result.spawnError !== undefined) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: `suup: could not start /bin/sh: ${result.spawnError.message}\n`,
        timedOut: false,
      };
    }
    return {
      exitCode: result.exitCode,
      stdout: decodeCaptured(result.stdout, result.stdoutTruncated, this.#maxOutputBytes),
      stderr: decodeCaptured(result.stderr, result.stderrTruncated, this.#maxOutputBytes),
      timedOut: result.timedOut,
    };
  }

  async readFile(path: string): Promise<string> {
    const real = await this.#resolve(path);
    const info = await stat(real);
    if (info.size > this.#maxFileBytes) {
      throw new Error(
        `file too large to read (${info.size} bytes, limit ${this.#maxFileBytes}): ${path}`,
      );
    }
    return readFile(real, "utf8");
  }

  async readFileBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    const real = await this.#resolve(path);
    const info = await stat(real);
    if (info.isDirectory()) throw new Error(`EISDIR: is a directory: ${path}`);
    const limit = Math.min(maxBytes, this.#maxFileBytes);
    if (info.size > limit) {
      throw new FileTooLargeError(path, info.size, limit);
    }
    return new Uint8Array(await readFile(real));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const real = await this.#resolve(path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content, "utf8");
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const real = await this.#resolve(path);
    const entries = await readdir(real, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        isDir = (await stat(join(real, entry.name)).catch(() => null))?.isDirectory() ?? false;
      }
      out.push({ name: entry.name, kind: isDir ? "dir" : "file" });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async stat(path: string): Promise<FileStat | null> {
    const real = await this.#resolve(path);
    try {
      const info = await stat(real);
      return info.isDirectory() ? { kind: "dir", size: 0 } : { kind: "file", size: info.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Lexical check, then symlink check on the deepest existing ancestor. Returns the real path. */
  async #resolve(path: string): Promise<string> {
    const lexical = resolveWorkspacePath(this.root, path);
    const [real, realRoot] = await Promise.all([resolveThroughLinks(lexical), realpath(this.root)]);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new WorkspaceEscapeError(path, "resolves through a symlink outside the workspace");
    }
    return real;
  }
}

/**
 * Like `realpath`, but the path (or its tail) may not exist: resolves the deepest existing
 * ancestor and appends the rest. A dangling symlink is followed to its target, so a link to a
 * not-yet-existing file outside the root is detected before a write would create it.
 */
async function resolveThroughLinks(path: string, hops = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink()) {
    if (hops > 40) throw new Error(`too many levels of symbolic links: ${path}`);
    const target = resolve(dirname(path), await readlink(path));
    return resolveThroughLinks(target, hops + 1);
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await resolveThroughLinks(parent, hops), basename(path));
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
