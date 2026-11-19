import { UsageError } from "./errors.js";
import type { CliIo } from "./io.js";

interface RawCapable {
  setRawMode?(mode: boolean): unknown;
}

/** Reads all of stdin as text. */
async function readAll(stdin: CliIo["stdin"]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads a secret value from the person, never from the command line (which other programs can
 * see, and shells keep in their history). With a terminal it is a prompt that shows nothing as
 * you type; without one (a pipe, a file) it is all of stdin, with the final line break removed.
 * Throws `UsageError` for an empty value.
 */
export async function readSecretValue(io: CliIo, prompt: string, command: string): Promise<string> {
  let value: string;
  if (io.stdin.isTTY === true) {
    value = await readHidden(io, prompt);
  } else {
    value = (await readAll(io.stdin)).replace(/\r?\n$/, "");
  }
  if (value === "") {
    throw new UsageError(
      "O valor está vazio. Passe o valor pela entrada padrão (echo -n ... | suup ...) ou digite-o no prompt.",
      command,
    );
  }
  return value;
}

function readHidden(io: CliIo, prompt: string): Promise<string> {
  const stdin = io.stdin as CliIo["stdin"] & RawCapable;
  return new Promise<string>((resolve, reject) => {
    io.stdout.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stdout.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("interrompido"));
        if (ch === "\u0004" && value === "") return finish();
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
