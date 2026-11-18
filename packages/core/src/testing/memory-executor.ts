import {
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type FileStat,
  resolveWorkspacePath,
} from "../tool.js";

const ROOT = "/workspace";

export interface MemoryExecutorOptions {
  /** Initial files, keyed by workspace-relative path. */
  files?: Record<string, string>;
  /** Handler for `exec`. Default: succeeds with empty output. */
  onExec?: (command: string, opts?: ExecOptions) => ExecResult | Promise<ExecResult>;
}

/**
 * In-memory `Executor` for tests: a flat map of files, no real shell. Paths go through
 * `resolveWorkspacePath`, so escapes throw `WorkspaceEscapeError` like a real implementation.
 */
export class MemoryExecutor implements Executor {
  readonly files = new Map<string, string>();
  readonly execCalls: { command: string; opts: ExecOptions | undefined }[] = [];
  /** When true, `writeFile` rejects (to simulate a full disk). */
  failWrites = false;
  readonly #onExec: NonNullable<MemoryExecutorOptions["onExec"]>;

  constructor(options: MemoryExecutorOptions = {}) {
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(resolveWorkspacePath(ROOT, path), content);
    }
    this.#onExec =
      options.onExec ?? (() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    return this.#onExec(command, opts);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(resolveWorkspacePath(ROOT, path));
    if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = resolveWorkspacePath(ROOT, path);
    if (this.failWrites) throw new Error("ENOSPC: simulated write failure");
    this.files.set(abs, content);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const abs = resolveWorkspacePath(ROOT, path);
    const prefix = abs === "/" ? "/" : `${abs}/`;
    const entries = new Map<string, DirEntry["kind"]>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, "file");
      else entries.set(rest.slice(0, slash), "dir");
    }
    if (entries.size === 0 && abs !== ROOT) throw new Error(`ENOENT: no such directory: ${path}`);
    return [...entries]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat | null> {
    const abs = resolveWorkspacePath(ROOT, path);
    const content = this.files.get(abs);
    if (content !== undefined) return { kind: "file", size: content.length };
    const prefix = abs === "/" ? "/" : `${abs}/`;
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) return { kind: "dir", size: 0 };
    }
    return abs === ROOT ? { kind: "dir", size: 0 } : null;
  }
}
