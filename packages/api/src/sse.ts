/** One frame of a Server-Sent Events stream, as the wire gives it (before any validation). */
export interface SseFrame {
  /** The `event:` field; `message` when the frame has none (the standard default). */
  event: string;
  /** The `data:` lines joined with a newline. */
  data: string;
  /** The `id:` field, when present. */
  id?: string;
}

/**
 * An incremental parser of the `text/event-stream` format (the HTML standard's algorithm): it takes
 * text in whatever pieces the network delivers it, in any line-ending style (LF, CRLF or CR), and
 * calls `onFrame` for each complete frame. Comment lines (`: ping`) are reported to `onComment`
 * (they are how the server says it is alive). Pure: no timers, no I/O.
 */
export function createSseParser(handlers: {
  onFrame(frame: SseFrame): void;
  onComment?(text: string): void;
  /** The server's `retry:` hint (milliseconds): how long to wait before reconnecting. */
  onRetry?(ms: number): void;
}): { push(chunk: string): void; reset(): void } {
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;
  let skipLf = false;

  const dispatch = () => {
    if (retry !== undefined) handlers.onRetry?.(retry);
    // As the standard says: a frame with no `data` dispatches nothing (a `retry:` or `id:` alone
    // only adjusts the connection).
    if (sawField && data.length > 0) {
      handlers.onFrame({
        event: event === "" ? "message" : event,
        data: data.join("\n"),
        ...(id === undefined ? {} : { id }),
      });
    }
    data = [];
    event = "";
    id = undefined;
    retry = undefined;
    sawField = false;
  };

  const line = (text: string) => {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return handlers.onComment?.(text.slice(1).trimStart());
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        sawField = true;
        break;
      case "data":
        data.push(value);
        sawField = true;
        break;
      case "id":
        if (!value.includes("\u0000")) {
          id = value;
          sawField = true;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          retry = Number(value);
          sawField = true;
        }
        break;
      default:
        break;
    }
  };

  return {
    push(chunk) {
      let text = buffer + chunk;
      buffer = "";
      if (skipLf && text.startsWith("\n")) text = text.slice(1);
      skipLf = false;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c !== "\n" && c !== "\r") continue;
        line(text.slice(start, i));
        if (c === "\r") {
          if (text[i + 1] === "\n") i += 1;
          else if (i + 1 === text.length) skipLf = true; // a CR at the end of a chunk: an LF may follow
        }
        start = i + 1;
      }
      buffer = text.slice(start);
    },
    reset() {
      buffer = "";
      skipLf = false;
      data = [];
      event = "";
      id = undefined;
      retry = undefined;
      sawField = false;
    },
  };
}
