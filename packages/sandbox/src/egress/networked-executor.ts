// Owns giving a machine's commands their way out: every `exec` runs with the proxy settings of its
// subject, and what the proxy refused during the command is added to the result, so the tool
// result says plainly which host was not allowed (the shell itself would only show "403").
import type { DirEntry, ExecOptions, ExecResult, Executor, FileStat } from "@suup/core";
import type { EgressService, EgressSubject } from "./types.js";

export class NetworkedExecutor implements Executor {
  readonly #inner: Executor;
  readonly #egress: EgressService;
  readonly #subject: EgressSubject;

  constructor(inner: Executor, egress: EgressService, subject: EgressSubject) {
    this.#inner = inner;
    this.#egress = egress;
    this.#subject = subject;
  }

  get isolated(): boolean {
    return this.#inner.isolated === true;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const session = this.#egress.open(this.#subject);
    let result: ExecResult;
    try {
      result = await this.#inner.exec(command, { ...opts, env: { ...session.env, ...opts.env } });
    } catch (error) {
      session.close();
      throw error;
    }
    const refusals = session.close();
    if (refusals.length === 0) return result;
    const notes = refusals.map(
      (r) =>
        `suup: network: ${r.message}. If the user agrees, ask for it with the request_network_access tool (host ${r.host}).`,
    );
    const stderr =
      result.stderr === "" || result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`;
    return { ...result, stderr: `${stderr}${notes.join("\n")}\n` };
  }

  readFile(path: string): Promise<string> {
    return this.#inner.readFile(path);
  }
  readFileBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    if (this.#inner.readFileBytes === undefined) {
      return Promise.reject(new Error("this machine cannot read files as bytes"));
    }
    return this.#inner.readFileBytes(path, maxBytes);
  }
  writeFile(path: string, content: string): Promise<void> {
    return this.#inner.writeFile(path, content);
  }
  listDir(path: string): Promise<DirEntry[]> {
    return this.#inner.listDir(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.#inner.stat(path);
  }
}
