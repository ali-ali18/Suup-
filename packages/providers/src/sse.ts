import { ProviderError } from "@suup/core";

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export interface SseMessage {
  /** Value of the `event:` field, if any. */
  event: string | undefined;
  /** `data:` lines joined with "\n". */
  data: string;
}

export interface SseOptions {
  signal?: AbortSignal;
  /** Called every time bytes arrive (used for the idle timeout). */
  onChunk?: () => void;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function readAbortable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Parses a server-sent-events body. Handles LF, CRLF and CR line endings (also when a CRLF is
 * split across chunks), multi-line `data:`, comments, a leading BOM and multi-byte characters
 * split across chunks. An event still pending when the body ends is dispatched if it has data
 * (some servers omit the final blank line).
 *
 * Read failures other than an abort become a retryable-if-nothing-was-yielded `network`
 * `ProviderError`. An abort rejects with an `AbortError`.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<SseMessage> {
  const { signal, onChunk } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const ready: SseMessage[] = [];

  const dispatch = () => {
    if (data.length > 0) ready.push({ event, data: data.join("\n") });
    event = undefined;
    data = [];
  };
  const onLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  /** Consumes complete lines from `buffer`. `atEof` allows a trailing CR to end a line. */
  const drain = (atEof: boolean) => {
    let pos = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (c === 10) {
        onLine(buffer.slice(pos, i));
        pos = i + 1;
      } else if (c === 13) {
        if (i + 1 === buffer.length && !atEof) break;
        onLine(buffer.slice(pos, i));
        if (buffer.charCodeAt(i + 1) === 10) i++;
        pos = i + 1;
      }
    }
    buffer = buffer.slice(pos);
  };

  try {
    for (;;) {
      let result: ReadResult;
      try {
        result = await readAbortable(reader, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ProviderError("network", `response stream failed: ${String(error)}`, {
          cause: error,
        });
      }
      if (result.done) {
        buffer += decoder.decode();
        drain(true);
        if (buffer !== "") {
          onLine(buffer);
          buffer = "";
        }
        dispatch();
        break;
      }
      onChunk?.();
      buffer += decoder.decode(result.value, { stream: true });
      drain(false);
      while (ready.length > 0) {
        const next = ready.shift();
        if (next !== undefined) yield next;
      }
    }
    while (ready.length > 0) {
      const next = ready.shift();
      if (next !== undefined) yield next;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
