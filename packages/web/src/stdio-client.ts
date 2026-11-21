// Owns the worker's side of the reader container: one long-lived child process (normally
// `docker exec -i <container> node serve.js`) that answers read requests as JSON lines. It starts
// the child at the first request, starts it again if it died, and never waits for an answer for
// longer than `timeoutMs`.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { WebReadOutcome, WebReadRequest } from "@suup/core";
import type { ReadResponseLine, ReadyLine } from "./stdio-protocol.js";

export interface StdioSpec {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
}

export interface StdioReaderClient {
  /** `true` once the child said it is ready and can render. `undefined` until the first start. */
  readonly renderAvailable: boolean | undefined;
  /** Starts the child if needed and resolves when it says it is ready (or rejects). */
  start(): Promise<ReadyLine>;
  read(request: WebReadRequest): Promise<WebReadOutcome>;
  close(): void;
}

interface Pending {
  resolve(outcome: WebReadOutcome): void;
  timer: NodeJS.Timeout;
}

export function createStdioReaderClient(
  spec: StdioSpec,
  options: { timeoutMs?: number; startTimeoutMs?: number } = {},
): StdioReaderClient {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<ReadyLine> | undefined;
  let renderAvailable: boolean | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (message: string) => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, reason: "unavailable", message });
      pending.delete(id);
    }
  };

  const start = (): Promise<ReadyLine> => {
    if (ready !== undefined) return ready;
    ready = new Promise<ReadyLine>((resolve, reject) => {
      const proc = spawn(spec.command, [...spec.args], {
        env: spec.env ?? {},
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      const startTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("the reader did not become ready in time"));
      }, startTimeoutMs);
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString("utf8");
      });
      createInterface({ input: proc.stdout }).on("line", (text) => {
        let line: ReadyLine | ReadResponseLine;
        try {
          line = JSON.parse(text) as ReadyLine | ReadResponseLine;
        } catch {
          return;
        }
        if (line.op === "ready") {
          clearTimeout(startTimer);
          renderAvailable = line.renderAvailable;
          resolve(line);
          return;
        }
        const item = pending.get(line.id);
        if (item === undefined) return;
        pending.delete(line.id);
        clearTimeout(item.timer);
        item.resolve(line.outcome);
      });
      proc.on("error", (error) => {
        clearTimeout(startTimer);
        reject(error);
      });
      proc.on("close", (code) => {
        clearTimeout(startTimer);
        if (child === proc) {
          child = undefined;
          ready = undefined;
        }
        const reason = `the reader stopped (exit code ${code ?? "none"})${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n")[0]}`}`;
        failAll(reason);
        reject(new Error(reason));
      });
    });
    // A start that fails is tried again by the next request.
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };

  return {
    get renderAvailable() {
      return renderAvailable;
    },
    start,
    async read(request) {
      try {
        await start();
      } catch (error) {
        return {
          ok: false,
          reason: "unavailable",
          message: `The reader service is not running: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const proc = child;
      if (proc === undefined) {
        return { ok: false, reason: "unavailable", message: "The reader service is not running." };
      }
      const id = nextId++;
      return await new Promise<WebReadOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({
            ok: false,
            reason: "timeout",
            message: `Reading ${request.url} took too long and was stopped.`,
          });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        const onAbort = () => {
          const item = pending.get(id);
          if (item === undefined) return;
          pending.delete(id);
          clearTimeout(item.timer);
          item.resolve({ ok: false, reason: "failed", message: "The read was cancelled." });
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        proc.stdin.write(
          `${JSON.stringify({ id, op: "read", url: request.url, ...(request.render === true ? { render: true } : {}) })}\n`,
        );
      });
    },
    close() {
      const proc = child;
      child = undefined;
      ready = undefined;
      proc?.stdin.end();
      proc?.kill("SIGTERM");
      failAll("the reader was closed");
    },
  };
}
