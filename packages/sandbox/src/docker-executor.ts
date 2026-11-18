import { randomBytes } from "node:crypto";
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
  EXEC_ESCAPE_MARKER,
  EXEC_SCRIPT,
  EXIT_ESCAPE,
  EXIT_EXEC_ESCAPE,
  EXIT_IS_DIR,
  EXIT_MKDIR_FAILED,
  EXIT_NOT_DIR,
  EXIT_NOT_FOUND,
  KILL_SCRIPT,
  LIST_SCRIPT,
  READ_SCRIPT,
  STAT_SCRIPT,
  WRITE_SCRIPT,
} from "./docker-scripts.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./limits.js";
import { decodeCaptured, runProcess } from "./run-process.js";

export const DEFAULT_WORKSPACE = "/workspace";
export const DEFAULT_USER = "bot";

/** Extra time the host waits, after the in-container limit, before killing the local client. */
const HOST_WATCHDOG_GRACE_MS = 5_000;
/** Limit for the small helper calls (file operations). */
const FILE_OP_TIMEOUT_MS = 60_000;

export interface DockerExecutorOptions {
  /** Name or id of an ALREADY RUNNING container (see `ensureMachine`). */
  container: string;
  /** Absolute workspace directory inside the container. Default `/workspace`. */
  workspace?: string;
  /** `docker exec --user` value. Default: the container's own user. */
  user?: string;
  /** Path of the docker CLI. Default `docker`. */
  dockerPath?: string;
  /** Cap per stream of one `exec`. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Largest file `readFile` accepts. Default 32 MiB. */
  maxFileBytes?: number;
}

/**
 * Executor that talks to a running container through the `docker` CLI.
 *
 * Host-side safety: `docker` is started with an argv array (never through a shell), and every
 * value that comes from the model (command, cwd, paths, env, file content) travels as a single
 * argv element or on stdin. Inside the container the values are only ever read from positional
 * parameters by constant scripts (see docker-scripts.ts), so they are never parsed as shell code
 * except for the command itself, which is meant to be.
 *
 * Timeouts: the command runs under coreutils `timeout -s KILL`, INSIDE the container. It kills
 * the command and its process group no matter what happens to the host-side client. On the host
 * the `docker exec` client also has a watchdog (limit + 5 s) and an abort handler; both run a
 * second `docker exec` that walks the process tree recorded in a pid file and kills it, then kill
 * the local client. Killing only the client would leave the command running.
 *
 * Known limits: a process that escapes the group (`setsid`) survives a timeout; a timeout is
 * reported as `exitCode: null` only when exit status 137 coincides with the elapsed limit.
 */
export class DockerExecutor implements Executor {
  readonly container: string;
  readonly workspace: string;
  readonly #user: string | undefined;
  readonly #docker: string;
  readonly #maxOutputBytes: number;
  readonly #maxFileBytes: number;

  constructor(options: DockerExecutorOptions) {
    assertName(options.container, "container");
    const workspace = options.workspace ?? DEFAULT_WORKSPACE;
    if (!workspace.startsWith("/") || workspace === "/" || workspace.includes("\0")) {
      throw new Error(`workspace must be an absolute directory other than "/": ${workspace}`);
    }
    if (options.user !== undefined && !/^[A-Za-z0-9_.][A-Za-z0-9_.:-]*$/.test(options.user)) {
      throw new Error(`invalid user: ${options.user}`);
    }
    this.container = options.container;
    this.workspace = resolveWorkspacePath("/", workspace);
    this.#user = options.user;
    this.#docker = options.dockerPath ?? "docker";
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (command.includes("\0")) throw new Error("command contains a NUL byte");
    const cwd = resolveWorkspacePath(this.workspace, opts.cwd ?? ".");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const pidfile = `/tmp/.suup-exec-${randomBytes(8).toString("hex")}.pid`;

    const args = ["exec", ...this.#userArgs()];
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`invalid environment variable name: ${key}`);
      if (value.includes("\0")) throw new Error(`environment variable ${key} contains a NUL byte`);
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      this.container,
      "sh",
      "-c",
      EXEC_SCRIPT,
      "sh",
      pidfile,
      (timeoutMs / 1000).toFixed(3),
      this.workspace,
      cwd,
      command,
    );

    const result = await runProcess(this.#docker, args, {
      env: hostEnv(),
      timeoutMs: timeoutMs + HOST_WATCHDOG_GRACE_MS,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      maxOutputBytes: this.#maxOutputBytes,
      killGroup: false,
      onTerminate: () => this.#killInContainer(pidfile),
    });
    if (result.spawnError !== undefined) {
      throw new Error(`could not run "${this.#docker}": ${result.spawnError.message}`);
    }

    const stdout = decodeCaptured(result.stdout, result.stdoutTruncated, this.#maxOutputBytes);
    const stderr = decodeCaptured(result.stderr, result.stderrTruncated, this.#maxOutputBytes);
    if (result.exitCode === EXIT_EXEC_ESCAPE && stderr.startsWith(EXEC_ESCAPE_MARKER)) {
      throw new WorkspaceEscapeError(
        opts.cwd ?? ".",
        "resolves through a symlink outside the workspace",
      );
    }
    const killedByLimit =
      result.timedOut || (result.exitCode === 137 && result.elapsedMs >= timeoutMs - 50);
    if (killedByLimit) return { exitCode: null, stdout, stderr, timedOut: true };
    if (result.aborted) return { exitCode: null, stdout, stderr, timedOut: false };
    return { exitCode: result.exitCode, stdout, stderr, timedOut: false };
  }

  async readFile(path: string): Promise<string> {
    const run = await this.#fileOp(READ_SCRIPT, path, undefined, this.#maxFileBytes);
    if (run.truncated)
      throw new Error(`file too large to read (limit ${this.#maxFileBytes} bytes): ${path}`);
    return run.stdout.toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#fileOp(WRITE_SCRIPT, path, Buffer.from(content, "utf8"));
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const run = await this.#fileOp(LIST_SCRIPT, path);
    const parts = run.stdout.toString("utf8").split("\0");
    parts.pop(); // output ends with a separator
    const entries: DirEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      entries.push({ name: parts[i + 1] as string, kind: parts[i] === "d" ? "dir" : "file" });
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async stat(path: string): Promise<FileStat | null> {
    const run = await this.#fileOp(STAT_SCRIPT, path, undefined, undefined, [EXIT_NOT_FOUND]);
    if (run.code === EXIT_NOT_FOUND) return null;
    const [type = "", size = "0"] = run.stdout.toString("utf8").trim().split("|");
    return type.startsWith("directory")
      ? { kind: "dir", size: 0 }
      : { kind: "file", size: Number(size) };
  }

  #userArgs(): string[] {
    return this.#user === undefined ? [] : ["-u", this.#user];
  }

  async #fileOp(
    script: string,
    path: string,
    input?: Uint8Array,
    maxBytes: number = this.#maxOutputBytes,
    tolerate: number[] = [],
  ): Promise<{ code: number; stdout: Buffer; truncated: boolean }> {
    const abs = resolveWorkspacePath(this.workspace, path);
    const args = [
      "exec",
      ...(input === undefined ? [] : ["-i"]),
      ...this.#userArgs(),
      this.container,
      "sh",
      "-c",
      script,
      "sh",
      this.workspace,
      abs,
    ];
    const result = await runProcess(this.#docker, args, {
      env: hostEnv(),
      ...(input === undefined ? {} : { input }),
      timeoutMs: FILE_OP_TIMEOUT_MS,
      maxOutputBytes: maxBytes,
      killGroup: false,
    });
    if (result.spawnError !== undefined) {
      throw new Error(`could not run "${this.#docker}": ${result.spawnError.message}`);
    }
    if (result.timedOut) throw new Error(`file operation timed out: ${path}`);
    const code = result.exitCode ?? -1;
    const stderr = result.stderr.toString("utf8").trim();
    if (code === 0 || tolerate.includes(code)) {
      return { code, stdout: result.stdout, truncated: result.stdoutTruncated };
    }
    switch (code) {
      case EXIT_ESCAPE:
        throw new WorkspaceEscapeError(path, "resolves through a symlink outside the workspace");
      case EXIT_NOT_FOUND:
      case EXIT_IS_DIR:
      case EXIT_NOT_DIR:
      case EXIT_MKDIR_FAILED:
        throw new Error(stderr || `file operation failed (${code}): ${path}`);
      default:
        throw new Error(`docker exec failed (exit ${code}): ${stderr || "no error output"}`);
    }
  }

  async #killInContainer(pidfile: string): Promise<void> {
    await runProcess(
      this.#docker,
      ["exec", ...this.#userArgs(), this.container, "sh", "-c", KILL_SCRIPT, "sh", pidfile],
      {
        env: hostEnv(),
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        killGroup: false,
      },
    );
  }
}

/** The docker client needs DOCKER_HOST, DOCKER_CONFIG and friends, so it keeps the host env. */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function assertName(value: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(
      `invalid ${what} "${value}": use letters, digits, "_", "." and "-", not starting with "-"`,
    );
  }
}

export { hostEnv as dockerClientEnv };
