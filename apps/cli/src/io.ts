import type { Readable } from "node:stream";

/** Everything the CLI touches in the outside world, so tests can inject it. */
export interface CliIo {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown };
  stdin: Readable & { isTTY?: boolean };
  env: Record<string, string | undefined>;
  cwd: string;
  /**
   * Registers a handler for Ctrl+C / SIGTERM; returns the function that unregisters it. Every
   * call to the handler is one more press.
   */
  onInterrupt(handler: () => void): () => void;
}

/** The real process. */
export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
  };
}
