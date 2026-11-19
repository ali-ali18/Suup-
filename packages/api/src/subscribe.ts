import { ApiError, type ErrorCode, errorBodySchema } from "./errors.js";
import { createSseParser, type SseFrame } from "./sse.js";
import { type StreamEvent, streamEventSchema } from "./stream.js";

/** Where the subscription is. */
export type SubscriptionStatus =
  /** Opening a connection (the first one, or after a drop). */
  | "connecting"
  /** Connected: `ready` arrived. */
  | "open"
  /** The connection dropped and a new one is scheduled. */
  | "reconnecting"
  /** Over: `close()` was called, or the server refused for good (see `onClose`). */
  | "closed";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** For the jitter of the backoff, in [0, 1). */
  random(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface SubscribeOptions {
  /** The runs whose events (`run.event`) to receive. Change them later with `setRuns`. */
  runs?: readonly string[];
  /** Resume from this event id (a saved one). Default: from now. */
  lastEventId?: number;
  /** Every event, in order. A throw is caught and reported to `onError`; the stream goes on. */
  onEvent(event: StreamEvent): void;
  onStatus?(status: SubscriptionStatus, detail?: string): void;
  /** Something went wrong that the subscription survives (a dropped connection, a bad frame). */
  onError?(error: ApiError): void;
  /** The server refused for good (a wrong token, an origin not allowed): no more attempts. */
  onClose?(error: ApiError | undefined): void;
  /** Wait before reconnecting: `minMs`, doubling up to `maxMs`, with jitter. Defaults 500 ms, 15 s. */
  backoff?: { minMs?: number; maxMs?: number };
  /**
   * A connection that sends nothing (not even the server's keep-alive comment) for this long is
   * considered dead and reopened. Default 45 s (the server pings every 15 s).
   */
  idleTimeoutMs?: number;
  /** Closes the subscription (same as `close()`). */
  signal?: AbortSignal;
}

export interface Subscription {
  /** The id of the last change seen: what a reconnection resumes from. */
  readonly lastEventId: number | undefined;
  readonly status: SubscriptionStatus;
  /** The runs the connection carries now. */
  readonly runs: readonly string[];
  /** Changes which runs' events arrive. Reopens the connection, resuming with no loss. */
  setRuns(runs: readonly string[]): void;
  close(): void;
}

export interface SubscribeDeps {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  timers?: Timers;
}

const FATAL: ReadonlySet<ErrorCode> = new Set(["unauthorized", "origin_not_allowed"]);

/**
 * Follows `GET /v1/stream` with `fetch` streaming (so the bearer token travels in a header, which
 * the browser's `EventSource` cannot do) and keeps it going: when the connection drops it reopens
 * after a growing pause and resumes from the last event id, so nothing is lost or repeated; a
 * server that says the gap is too old gets a `resync` event, which the app answers by reloading
 * what it shows. Frames that do not match the contract are reported and skipped.
 */
export function subscribe(deps: SubscribeDeps, options: SubscribeOptions): Subscription {
  const timers = deps.timers ?? realTimers;
  const minMs = options.backoff?.minMs ?? 500;
  const maxMs = options.backoff?.maxMs ?? 15_000;
  const idleMs = options.idleTimeoutMs ?? 45_000;

  let status: SubscriptionStatus = "connecting";
  let lastEventId = options.lastEventId;
  let runs = [...new Set(options.runs ?? [])];
  let closed = false;
  let attempt = 0;
  let abort: AbortController | undefined;
  let retryTimer: unknown;
  /** Set by `setRuns`: the next end of connection is on purpose, reopen at once. */
  let reopening = false;

  const setStatus = (next: SubscriptionStatus, detail?: string) => {
    if (status === next && detail === undefined) return;
    status = next;
    try {
      options.onStatus?.(next, detail);
    } catch {
      // a broken listener must not break the stream
    }
  };
  const report = (error: ApiError) => {
    try {
      options.onError?.(error);
    } catch {
      // idem
    }
  };

  const url = () => {
    const query = new URLSearchParams();
    if (runs.length > 0) query.set("runs", runs.join(","));
    const text = query.toString();
    return `${deps.baseUrl.replace(/\/+$/, "")}/v1/stream${text === "" ? "" : `?${text}`}`;
  };

  const finish = (error?: ApiError) => {
    if (closed) return;
    closed = true;
    abort?.abort();
    timers.clearTimeout(retryTimer);
    setStatus("closed", error?.message);
    try {
      options.onClose?.(error);
    } catch {
      // idem
    }
  };

  const schedule = () => {
    if (closed) return;
    const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 20));
    const wait = Math.round(base * (0.8 + 0.4 * timers.random()));
    attempt += 1;
    setStatus("reconnecting");
    retryTimer = timers.setTimeout(() => void connect(), wait);
  };

  const handleFrame = (frame: SseFrame) => {
    let data: unknown;
    try {
      data = frame.data === "" ? {} : JSON.parse(frame.data);
    } catch {
      return report(
        new ApiError("invalid_response", `Quadro do stream com JSON inválido (${frame.event}).`),
      );
    }
    const id = frame.id === undefined ? undefined : Number(frame.id);
    const parsed = streamEventSchema.safeParse({
      type: frame.event,
      ...(id === undefined ? {} : { id }),
      data,
    });
    if (!parsed.success) {
      return report(
        new ApiError(
          "invalid_response",
          `Quadro do stream fora do contrato (${frame.event}).`,
          undefined,
          {
            cause: parsed.error,
          },
        ),
      );
    }
    const event = parsed.data;
    // Defensive: the server never repeats an id on one connection, and a resumed connection starts
    // after the last one; a frame at or below what was already seen is dropped, not delivered twice.
    if (event.id !== undefined && lastEventId !== undefined && event.id <= lastEventId) return;
    if (event.type === "ready") {
      attempt = 0;
      setStatus("open");
      // Nothing seen yet, or the server cannot resume us: from now on, resume from the head.
      if (lastEventId === undefined || event.data.resync) lastEventId = event.data.head;
    } else if (event.id !== undefined) {
      lastEventId = event.id;
    }
    try {
      options.onEvent(event);
    } catch (error) {
      report(
        new ApiError(
          "invalid_response",
          `O tratador de eventos falhou: ${String(error)}`,
          undefined,
          { cause: error },
        ),
      );
    }
  };

  async function connect(): Promise<void> {
    if (closed) return;
    setStatus("connecting");
    const controller = new AbortController();
    abort = controller;
    let idleTimer: unknown;
    const kick = () => {
      timers.clearTimeout(idleTimer);
      idleTimer = timers.setTimeout(() => controller.abort(), idleMs);
    };
    try {
      kick();
      const response = await deps.fetch(url(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${deps.token}`,
          Accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        const error = await errorOf(response);
        if (FATAL.has(error.code as ErrorCode)) return finish(error);
        report(error);
        return schedule();
      }
      const decoder = new TextDecoder();
      const parser = createSseParser({
        onFrame: handleFrame,
        onComment: () => {},
      });
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      // The server ended the stream (a restart, a slow client dropped on purpose): reconnect.
      if (!closed && !reopening)
        report(new ApiError("network", "O servidor encerrou o stream; reconectando."));
    } catch (error) {
      if (!closed && !reopening) {
        report(
          new ApiError(
            "network",
            controller.signal.aborted
              ? "O stream ficou sem sinais do servidor; reconectando."
              : `Falha de rede no stream: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            { cause: error },
          ),
        );
      }
    } finally {
      timers.clearTimeout(idleTimer);
    }
    if (closed) return;
    if (reopening) {
      reopening = false;
      attempt = 0;
      return void connect();
    }
    schedule();
  }

  options.signal?.addEventListener("abort", () => finish(), { once: true });
  if (options.signal?.aborted) finish();
  else void connect();

  return {
    get lastEventId() {
      return lastEventId;
    },
    get status() {
      return status;
    },
    get runs() {
      return runs;
    },
    setRuns(next) {
      const wanted = [...new Set(next)];
      if (closed || (wanted.length === runs.length && wanted.every((r) => runs.includes(r))))
        return;
      runs = wanted;
      timers.clearTimeout(retryTimer);
      if (status === "reconnecting") {
        // Waiting to reconnect anyway: do it now, with the new list.
        void connect();
        return;
      }
      reopening = true;
      abort?.abort();
    },
    close() {
      finish();
    },
  };
}

/** The error an unsuccessful answer carries (the contract's body when it has one). */
export async function errorOf(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(parsed.data.error.code, parsed.data.error.message, response.status);
  }
  return new ApiError(
    "invalid_response",
    `O servidor respondeu ${response.status} sem o corpo de erro do contrato.`,
    response.status,
  );
}
