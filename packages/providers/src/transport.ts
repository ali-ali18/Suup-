import { ProviderError, type ProviderEvent } from "@suup/core";
import { z } from "zod";
import { headersToRecord } from "./common.js";
import { backoffDelay, defaultSleep, type Sleep } from "./retry.js";
import { parseSse, type SseMessage } from "./sse.js";

/** One HTTP attempt, reported to `onExchange` when the attempt ends. */
export interface ExchangeInfo {
  /** The exact JSON body sent. Request headers are never reported (no key can leak). */
  requestBody: unknown;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 1 for the first attempt, 2 for the first retry, ... */
  attempt: number;
  /** Set when the attempt failed (HTTP error, network failure, broken stream, abort). */
  error?: string;
}

export interface BaseProviderConfig {
  /** Becomes `Provider.id` (and the `provider` stamped on `provider_data` blocks). */
  id: string;
  baseUrl?: string;
  /** Never logged and scrubbed from error messages. */
  apiKey: string;
  /** Extra request headers; they override the defaults (names are case-insensitive). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Retries after the first attempt, only for retryable errors before the first event. Default 3. */
  maxRetries?: number;
  /**
   * Inactivity timeout per HTTP attempt: from sending the request until the headers arrive, and
   * then between received chunks. Expiry is a retryable `network` error. Default: none.
   */
  requestTimeoutMs?: number;
  /** Called once per HTTP attempt, when the attempt ends. */
  onExchange?: (exchange: ExchangeInfo) => void;
  /** First backoff step. Default 500. */
  retryBaseDelayMs?: number;
  /** Backoff cap; a server `retry-after` above it is not waited for (the error is thrown). Default 30000. */
  retryMaxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: Sleep;
  /** Injectable for tests; returns [0, 1). */
  random?: () => number;
  /** Merged into the top level of the request JSON body; fields the adapter sets win. */
  extraBody?: Record<string, unknown>;
}

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === "function");
const baseConfigSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  fetch: fn.optional(),
  maxRetries: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().positive().optional(),
  onExchange: fn.optional(),
  retryBaseDelayMs: z.number().min(0).optional(),
  retryMaxDelayMs: z.number().min(0).optional(),
  sleep: fn.optional(),
  random: fn.optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

export function validateBaseConfig(config: BaseProviderConfig): void {
  const parsed = baseConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`Invalid provider config: ${issues.join("; ")}`);
  }
}

export interface Transport {
  apiKey: string;
  fetch: typeof fetch;
  maxRetries: number;
  requestTimeoutMs: number | undefined;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  sleep: Sleep;
  random: () => number;
  onExchange: ((exchange: ExchangeInfo) => void) | undefined;
}

export function resolveTransport(config: BaseProviderConfig): Transport {
  validateBaseConfig(config);
  const customFetch = config.fetch;
  return {
    apiKey: config.apiKey,
    fetch: customFetch ?? ((input, init) => globalThis.fetch(input, init)),
    maxRetries: config.maxRetries ?? 3,
    requestTimeoutMs: config.requestTimeoutMs,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 500,
    retryMaxDelayMs: config.retryMaxDelayMs ?? 30_000,
    sleep: config.sleep ?? defaultSleep,
    random: config.random ?? Math.random,
    onExchange: config.onExchange,
  };
}

export interface RequestJob {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface WireHooks {
  /** Maps a non-2xx response to a `ProviderError`. `bodyText` is already key-scrubbed. */
  mapHttpError(status: number, headers: Headers, bodyText: string): ProviderError;
  /** Turns the SSE messages of one successful response into provider events. */
  parse(messages: AsyncIterable<SseMessage>): AsyncGenerator<ProviderEvent>;
}

/** Lower-cases header names, later entries winning. */
export function mergeHeaders(...sets: (Record<string, string> | undefined)[]) {
  const out: Record<string, string> = {};
  for (const set of sets) {
    if (set === undefined) continue;
    for (const [key, value] of Object.entries(set)) out[key.toLowerCase()] = value;
  }
  return out;
}

const abortedError = () => new ProviderError("aborted", "request aborted");

function scrub(text: string, apiKey: string): string {
  return apiKey.length >= 6 ? text.split(apiKey).join("[redacted]") : text;
}

function sanitize(error: ProviderError, apiKey: string): ProviderError {
  const message = scrub(error.message, apiKey);
  if (message === error.message) return error;
  return new ProviderError(error.kind, message, {
    retryable: error.retryable,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  });
}

function withoutRetry(error: ProviderError): ProviderError {
  if (!error.retryable) return error;
  return new ProviderError(error.kind, error.message, {
    retryable: false,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** One HTTP attempt. Throws only `ProviderError`s. */
async function* attemptOnce(
  t: Transport,
  job: RequestJob,
  userSignal: AbortSignal | undefined,
  hooks: WireHooks,
  exchange: ExchangeInfo,
): AsyncGenerator<ProviderEvent> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (t.requestTimeoutMs === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, t.requestTimeoutMs);
  };
  const onUserAbort = () => controller.abort();
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  if (userSignal?.aborted) controller.abort();

  try {
    touch();
    const response = await raceAbort(
      t.fetch(job.url, {
        method: "POST",
        headers: job.headers,
        body: JSON.stringify(job.body),
        signal: controller.signal,
      }),
      controller.signal,
    );
    exchange.status = response.status;
    exchange.responseHeaders = headersToRecord(response.headers);
    touch();

    if (!response.ok) {
      let text = "";
      try {
        text = (await raceAbort(response.text(), controller.signal)).slice(0, 16_384);
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      throw hooks.mapHttpError(response.status, response.headers, scrub(text, t.apiKey));
    }
    if (response.body === null) {
      throw new ProviderError("network", "response has no body");
    }
    const messages = parseSse(response.body, { signal: controller.signal, onChunk: touch });
    for await (const event of hooks.parse(messages)) yield event;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (userSignal?.aborted) throw abortedError();
    if (timedOut) {
      throw new ProviderError(
        "network",
        `request timed out after ${t.requestTimeoutMs}ms of inactivity`,
      );
    }
    if (error instanceof Error && error.name === "AbortError") throw abortedError();
    const detail = error instanceof Error ? error.message : String(error);
    const looksLikeFetchFailure = error instanceof TypeError || error instanceof Error;
    if (looksLikeFetchFailure && exchange.status === null) {
      throw new ProviderError("network", `network error: ${detail}`, { cause: error });
    }
    // Anything else after the response started is a bug in the adapter, not a transient failure.
    throw new ProviderError("unknown", `unexpected adapter error: ${detail}`, {
      retryable: false,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
  }
}

/**
 * Sends the request and streams provider events, retrying retryable failures that happen before
 * the first event reached the caller (never replays a half-delivered stream).
 */
export async function* streamWithRetry(
  t: Transport,
  job: RequestJob,
  signal: AbortSignal | undefined,
  hooks: WireHooks,
): AsyncGenerator<ProviderEvent> {
  let yielded = false;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortedError();
    const exchange: ExchangeInfo = {
      requestBody: job.body,
      status: null,
      responseHeaders: {},
      attempt,
    };
    let failure: ProviderError;
    try {
      for await (const event of attemptOnce(t, job, signal, hooks, exchange)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      failure = sanitize(
        error instanceof ProviderError ? error : new ProviderError("unknown", String(error)),
        t.apiKey,
      );
      exchange.error = failure.message;
    } finally {
      if (t.onExchange !== undefined) {
        try {
          t.onExchange(exchange);
        } catch {
          // diagnostics must never break a request
        }
      }
    }

    if (yielded) throw withoutRetry(failure);
    const retriesLeft = attempt <= t.maxRetries;
    if (!failure.retryable || !retriesLeft || signal?.aborted) throw failure;
    if (failure.retryAfterMs !== undefined && failure.retryAfterMs > t.retryMaxDelayMs)
      throw failure;
    const delay =
      failure.retryAfterMs ??
      backoffDelay(attempt - 1, t.retryBaseDelayMs, t.retryMaxDelayMs, t.random);
    try {
      await t.sleep(delay, signal);
    } catch (error) {
      if (signal?.aborted) throw abortedError();
      throw new ProviderError("unknown", `retry wait failed: ${String(error)}`, {
        retryable: false,
        cause: error,
      });
    }
  }
}
