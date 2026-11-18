import { z } from "zod";

/**
 * Every error the server answers with: `{ "error": { "code", "message" } }`. The list is closed:
 * a client can switch on `code`; `message` is for the person, in Brazilian Portuguese.
 */
export const ERROR_CODES = [
  /** No bearer token, or a wrong one. */
  "unauthorized",
  /** The browser origin is not in the server's list. */
  "origin_not_allowed",
  /** Malformed JSON, a missing or invalid field, a bad query parameter. */
  "invalid_request",
  /** The route or the thing it names does not exist. */
  "not_found",
  /** The route exists, not for this method. */
  "method_not_allowed",
  /** The request took too long to arrive or to answer. */
  "request_timeout",
  /** The thing exists but its state does not allow this (a finished run cannot be paused...). */
  "conflict",
  /** The body is larger than the server accepts. */
  "payload_too_large",
  /** The body is not JSON. */
  "unsupported_media_type",
  /** The server already serves as many realtime streams as it allows. */
  "too_many_streams",
  /** The model provider failed (drafting a bot, resending a request...). */
  "provider_error",
  /** A defect of the server. The details are in its log, not here. */
  "internal_error",
  /** The server cannot serve right now (database down, shutting down). */
  "unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES);

/** The HTTP status each code travels with. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  origin_not_allowed: 403,
  invalid_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  request_timeout: 408,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_streams: 429,
  provider_error: 502,
  internal_error: 500,
  unavailable: 503,
};

export const errorBodySchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Failures that did not come from an answer of the server. */
export type ClientErrorCode =
  /** The request never got an answer (the network, a closed port, a timeout of the client). */
  | "network"
  /** The server answered, but not with what the contract says (a wrong server, or a newer one). */
  | "invalid_response"
  /** The caller aborted. */
  | "aborted";

/** What the client throws: an error of the server, with its status, or a failure to reach it. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: ErrorCode | ClientErrorCode,
    message: string,
    /** The HTTP status, when there was an answer. */
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
