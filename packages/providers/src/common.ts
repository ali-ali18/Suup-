import { ProviderError, type ProviderErrorKind } from "@suup/core";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Lower-cased header name -> value. `set-cookie` is dropped. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Server-suggested wait in ms: `retry-after-ms`, or `retry-after` as seconds or an HTTP date.
 */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms))) {
    return Math.max(0, Math.round(Number(ms)));
  }
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return undefined;
  if (Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value) * 1000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

const CONTEXT_OVERFLOW =
  /context[_ ]length|context window|context size|prompt is too long|too many tokens|maximum context|exceeds? the (available )?context|input is too long|reduce the length/i;

/** Heuristic over vendor messages / codes: the prompt does not fit in the model's context. */
export function looksLikeContextOverflow(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => t !== undefined && CONTEXT_OVERFLOW.test(t));
}

export interface ErrorClass {
  kind: ProviderErrorKind;
  retryable?: boolean;
}

/** HTTP status -> error kind, shared by both adapters. `contextOverflow` refines 400s. */
export function classifyStatus(status: number, contextOverflow: boolean): ErrorClass {
  if (status === 401 || status === 402 || status === 403) return { kind: "auth" };
  if (status === 408) return { kind: "network", retryable: true };
  if (status === 409) return { kind: "unknown", retryable: true };
  if (status === 413) return { kind: "context_overflow" };
  if (status === 429) return { kind: "rate_limit" };
  if (status === 502 || status === 503 || status === 504 || status === 529) {
    return { kind: "overloaded" };
  }
  if (status >= 500) return { kind: "unknown", retryable: true };
  if (status >= 400) {
    return { kind: contextOverflow ? "context_overflow" : "invalid_request", retryable: false };
  }
  return { kind: "unknown", retryable: false };
}

export interface BuildErrorInput {
  vendor: string;
  cls: ErrorClass;
  message: string;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
}

export function buildError(input: BuildErrorInput): ProviderError {
  const prefix = input.status !== undefined ? `${input.vendor} HTTP ${input.status}` : input.vendor;
  return new ProviderError(input.cls.kind, `${prefix}: ${truncate(input.message)}`, {
    ...(input.cls.retryable !== undefined ? { retryable: input.cls.retryable } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
}

export function malformedEvent(vendor: string, cause?: unknown): ProviderError {
  return new ProviderError("network", `${vendor}: malformed event in response stream`, {
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function prematureEnd(vendor: string, detail: string): ProviderError {
  return new ProviderError("network", `${vendor}: stream ended prematurely (${detail})`);
}
