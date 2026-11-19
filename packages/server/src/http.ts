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
  regex: RegExp;
  keys: string[];
}

export function compileRoute(route: Route): Matcher {
  const keys: string[] = [];
  const source = route.pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { route, regex: new RegExp(`^${source}$`), keys };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export function newRequestId(): string {
  return randomBytes(6).toString("hex");
}

/** An id the client sent in `X-Request-Id`, if it is harmless to echo and log. */
export function acceptRequestId(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(header) ? header : undefined;
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
