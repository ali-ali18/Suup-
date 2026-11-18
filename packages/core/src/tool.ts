import type { z } from "zod";

/**
 * How much a tool can hurt: `read` observes only, `write` changes state inside the bot's own
 * workspace, `external` has effects outside it (sends, posts, pays) and is usually irreversible.
 */
export type ToolRisk = "read" | "write" | "external";

export interface ExecOptions {
  /** Working directory, relative to the workspace root. Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface ExecResult {
  /** `null` when the process did not exit normally (killed by a signal, timed out). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
}

export interface FileStat {
  kind: "file" | "dir";
  size: number;
}

/**
 * The bot's machine. Implemented by the sandbox package; tools only ever see this interface.
 *
 * All paths are relative to the bot workspace. An implementation MUST reject any path that
 * escapes the workspace (`..` segments, absolute paths outside it, NUL bytes) by throwing
 * `WorkspaceEscapeError`. `resolveWorkspacePath` does the lexical part of that check; resolving
 * symlinks (a link inside the workspace pointing outside it) is the implementation's job, because
 * it needs the real filesystem.
 */
export interface Executor {
  /** Runs a shell command. Resolves (never rejects) for non-zero exits and timeouts. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Reads a UTF-8 text file. Rejects if it does not exist. */
  readFile(path: string): Promise<string>;
  /** Writes a UTF-8 text file, creating parent directories and replacing existing content. */
  writeFile(path: string, content: string): Promise<void>;
  /** Lists a directory (non-recursive). Rejects if it is not a directory. */
  listDir(path: string): Promise<DirEntry[]>;
  /** Returns `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
}

/** Thrown when a path would resolve outside the workspace root. */
export class WorkspaceEscapeError extends Error {
  override readonly name = "WorkspaceEscapeError";
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`path escapes the workspace (${reason}): ${JSON.stringify(path)}`);
    this.path = path;
  }
}

/**
 * Lexically resolves `relative` against the absolute POSIX `root` and returns the normalized
 * absolute path. Pure: no filesystem access, so symlinks are NOT handled here.
 *
 * Accepts relative paths and absolute paths that are inside `root`. Throws
 * `WorkspaceEscapeError` for `..` climbing above `root`, absolute paths outside it and NUL bytes.
 * An empty path or "." is the root itself. Backslashes are ordinary characters.
 */
export function resolveWorkspacePath(root: string, relative: string): string {
  if (!root.startsWith("/")) throw new Error(`workspace root must be absolute: ${root}`);
  if (relative.includes("\0")) throw new WorkspaceEscapeError(relative, "NUL byte");

  const rootSegments = normalizeSegments(root.split("/"), root, false);
  let segments: string[];
  if (relative.startsWith("/")) {
    segments = normalizeSegments(relative.split("/"), relative, true);
    const inside = rootSegments.every((segment, i) => segments[i] === segment);
    if (!inside) throw new WorkspaceEscapeError(relative, "absolute path outside the workspace");
  } else {
    segments = [...rootSegments];
    for (const part of relative.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (segments.length <= rootSegments.length) {
          throw new WorkspaceEscapeError(relative, "'..' above the workspace root");
        }
        segments.pop();
      } else {
        segments.push(part);
      }
    }
  }
  return `/${segments.join("/")}`;
}

function normalizeSegments(parts: string[], original: string, strict: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        if (strict) throw new WorkspaceEscapeError(original, "'..' above the filesystem root");
        continue;
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Everything a tool may touch. Tools never reach the database, the provider or other tools. */
export interface ToolContext {
  runId: string;
  botId: string;
  executor: Executor;
  /** Aborted on cancellation or timeout. Long-running tools must honor it. */
  signal: AbortSignal;
  now(): Date;
}

export interface ToolOutput {
  /** Text handed back to the model. */
  content: string;
  /** The call failed; `content` should say why and how to fix it. */
  isError?: boolean;
  /**
   * The content came from outside (web pages, emails, files fetched from elsewhere). The registry
   * wraps it in an envelope marking it as data, not instructions.
   */
  untrusted?: boolean;
}

/**
 * A capability exposed to the model. A tool implements only the action: validation, risk gating,
 * timeouts, truncation and event logging are done around it by the registry.
 */
export interface Tool<I = unknown> {
  /** `^[a-z][a-z0-9_]{0,63}$`. */
  name: string;
  /** Shown to the model: what it does and when to use it. */
  description: string;
  /** Input schema. Its JSON Schema form is what the model sees; it must describe an object. */
  input: z.ZodType<I>;
  risk: ToolRisk;
  /** Overrides the registry's default timeout. */
  timeoutMs?: number;
  /**
   * Runs the action with already-validated input. Throwing is allowed (it becomes a "crashed"
   * outcome), but expected failures should be returned as `{ isError: true }` with a helpful text.
   */
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** Identity helper that infers `I` from the zod schema. */
export function defineTool<I>(tool: Tool<I>): Tool<I> {
  return tool;
}
