import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ERROR_STATUS, type ErrorCode } from "@suup/api";
import type { Runtime } from "@suup/runtime";
import type { z } from "zod";
import { HttpError, toHttpError } from "./errors.js";

/** What a handler answers: a status (default 200) and a JSON body. */
export interface Reply {
  status?: number;
  body: unknown;
}

/** Everything a handler may read about the request, already checked (auth, CORS, body size). */
export interface Ctx {
  readonly runtime: Runtime;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly requestId: string;
  /** Whether the doctor checks the bot machine from this process (see `ServerOptions.checkSandbox`). */
  readonly doctorSandbox: boolean;
  /** Aborted when the client goes away or the request times out. */
  readonly signal: AbortSignal;
  readonly req: IncomingMessage;
  /** Validates the query string against a schema (`invalid_request` on failure). */
  query<S extends z.ZodType>(schema: S): z.output<S>;
  /** Validates the JSON body against a schema (`invalid_request` on failure). A missing body is `{}`. */
  body<S extends z.ZodType>(schema: S): z.output<S>;
  /** A path parameter that must be a UUID: anything else names no resource (`not_found`). */
  uuid(name: string): string;
}

export type Handler = (ctx: Ctx) => Promise<Reply>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `/v1/bots/:id/archive`: `:name` matches one path segment. */
  pattern: string;
  handler: Handler;
  /** Longer than the server default for routes that call a model. */
  timeoutMs?: number;
}

export interface Matcher {
  route: Route;
  /** The route's pattern split by `/`: a segment starting with `:` is a parameter, the rest must be equal. */
  segments: string[];
  keys: string[];
}

export function compileRoute(route: Route): Matcher {
  const segments = route.pattern.split("/");
  const keys = segments.filter((s) => s.startsWith(":")).map((s) => s.slice(1));
  return { route, segments, keys };
}

/** The captured parameters (raw, in order) when the path has the route's shape, else `null`. Plain comparison, no pattern. */
export function matchRoute(matcher: Matcher, path: string): string[] | null {
  const parts = path.split("/");
  if (parts.length !== matcher.segments.length) return null;
  const captured: string[] = [];
  for (const [i, segment] of matcher.segments.entries()) {
    const part = parts[i] as string;
    if (segment.startsWith(":")) {
      if (part === "") return null;
      captured.push(part);
    } else if (segment !== part) {
      return null;
    }
  }
  return captured;
}

const HEX = "0123456789abcdef";
const UUID_DASHES = [8, 13, 18, 23];

/** A UUID's fixed shape (8-4-4-4-12 hexadecimal digits), checked position by position. */
export const isUuid = (value: string): boolean => {
  if (value.length !== 36) return false;
  for (let i = 0; i < 36; i += 1) {
    const ch = value[i]?.toLowerCase() ?? "";
    if (UUID_DASHES.includes(i) ? ch !== "-" : !HEX.includes(ch)) return false;
  }
  return true;
};

export function newRequestId(): string {
  return randomBytes(6).toString("hex");
}

/** An id the client sent in `X-Request-Id`, if it is harmless to echo and log. */
export function acceptRequestId(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || header.length < 1 || header.length > 64) return undefined;
  const harmless = (ch: string): boolean =>
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "." ||
    ch === "_" ||
    ch === "-";
  return [...header].every(harmless) ? header : undefined;
}

export interface BodyLimits {
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Reads the JSON body of a request. No body is `undefined`. Throws `HttpError`: `payload_too_large`
 * (the limit is checked on the declared length first and again while reading),
 * `unsupported_media_type`, `request_timeout`, `invalid_request` (not JSON).
 */
export async function readJsonBody(req: IncomingMessage, limits: BodyLimits): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limits.maxBytes) {
    throw new HttpError(
      "payload_too_large",
      `O corpo passa do limite de ${limits.maxBytes} bytes.`,
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new HttpError("request_timeout", "O corpo da requisição demorou demais para chegar."),
        ),
      limits.timeoutMs,
    );
    const done = (error?: unknown) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxBytes) {
        done(
          new HttpError(
            "payload_too_large",
            `O corpo passa do limite de ${limits.maxBytes} bytes.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => done();
    const onError = (error: Error) => done(error);
    const onAborted = () =>
      done(new HttpError("invalid_request", "A conexão caiu antes do fim do corpo."));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
  if (size === 0) return undefined;
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)) {
    throw new HttpError(
      "unsupported_media_type",
      "O corpo precisa ser JSON (Content-Type: application/json).",
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("invalid_request", "O corpo não é um JSON válido.");
  }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface Writer {
  json(status: number, body: unknown, extra?: Record<string, string>, close?: boolean): void;
  /** `close`: also close the connection once the answer is out (the request body was not read). */
  error(error: HttpError, close?: boolean): void;
}

/** Writes a JSON answer once; later calls (a handler that finished after a timeout) do nothing. */
export function writerFor(
  res: ServerResponse,
  base: Record<string, string>,
  closeAfter: () => boolean,
): Writer {
  const json = (
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
    close = false,
  ) => {
    if (res.headersSent || res.writableEnded) return;
    const payload = status === 204 ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...base,
      ...extra,
      ...(status === 204 ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      "Content-Length": String(Buffer.byteLength(payload)),
      ...(close || closeAfter() ? { Connection: "close" } : {}),
    });
    // After the answer is flushed, end the socket (the client may still be sending a body).
    res.end(payload, () => {
      if (close) res.socket?.destroySoon();
    });
  };
  return {
    json,
    error(error, close = false) {
      const extra: Record<string, string> = {};
      if (error.code === "unauthorized") extra["WWW-Authenticate"] = 'Bearer realm="suup"';
      json(
        ERROR_STATUS[error.code],
        { error: { code: error.code, message: error.message } },
        extra,
        close,
      );
    },
  };
}

/** The `HttpError` for a status the server produces itself, from its code. */
export const httpError = (code: ErrorCode, message: string): HttpError =>
  new HttpError(code, message);

export { toHttpError };
