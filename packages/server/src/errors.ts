import { ERROR_STATUS, type ErrorCode } from "@suup/api";
import {
  ApprovalError,
  ConversationNotFoundError,
  ConversationRuleError,
  RuleError,
  RunControlError,
  RunNotFoundError,
  SecretNotFoundError,
  WrittenRuleError,
} from "@suup/db";
import { ConfigError, RuntimeError, VaultError } from "@suup/runtime";
import { z } from "zod";

/** An error the server answers with: `code` picks the status, `message` is for the person. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

/** A problem with how the server is set up (no token, a weak one...). Thrown before it listens. */
export class ServerConfigError extends Error {
  override readonly name = "ServerConfigError";
}

const TYPE_PT: Record<string, string> = {
  string: "texto",
  number: "número",
  int: "número inteiro",
  boolean: "verdadeiro ou falso",
  object: "objeto",
  array: "lista",
  record: "objeto",
  null: "null",
};

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      // zod leaves the offending value out of the issue; its message says what was received.
      return /received undefined\b/.test(issue.message)
        ? "campo obrigatório ausente"
        : `esperado ${TYPE_PT[String(issue.expected)] ?? String(issue.expected)}`;
    case "too_small": {
      const n = String(issue.minimum);
      if (issue.origin === "string")
        return `deve ter no mínimo ${n} caractere${n === "1" ? "" : "s"}`;
      if (issue.origin === "array") return `deve ter no mínimo ${n} ite${n === "1" ? "m" : "ns"}`;
      return `deve ser no mínimo ${n}`;
    }
    case "too_big": {
      const n = String(issue.maximum);
      if (issue.origin === "string") return `deve ter no máximo ${n} caracteres`;
      if (issue.origin === "array") return `deve ter no máximo ${n} itens`;
      return `deve ser no máximo ${n}`;
    }
    case "invalid_format":
      return issue.format === "uuid"
        ? "deve ser um UUID válido"
        : issue.format === "datetime"
          ? "deve ser uma data ISO 8601 em UTC (ex.: 2026-11-18T20:13:08.123Z)"
          : "formato inválido";
    case "invalid_value":
      return `valor inválido; opções: ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "unrecognized_keys":
      return `campo${issue.keys.length > 1 ? "s" : ""} desconhecido${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}`;
    case "invalid_union":
      return "valor inválido";
    default:
      // `custom` issues are the messages written in the schemas, already in Portuguese.
      return issue.message;
  }
}

/** Portuguese lines for the problems of a body or a query (zod's own messages are English). */
export function describeZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path === "" ? "corpo" : path}: ${describeIssue(issue)}`;
    })
    .join("; ");
}

const NOT_FOUND = new Set([
  "bot_not_found",
  "run_not_found",
  "event_not_found",
  "conversation_not_found",
  "memory_not_found",
  "connector_not_found",
]);

const DB_DOWN = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
]);

/** Turns whatever a handler threw into the error the client gets. Never leaks internals. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof z.ZodError)
    return new HttpError("invalid_request", describeZod(error), { cause: error });
  if (error instanceof RuntimeError) {
    if (NOT_FOUND.has(error.code))
      return new HttpError("not_found", error.message, { cause: error });
    switch (error.code) {
      case "draft_failed":
        return new HttpError("provider_error", error.message, { cause: error });
      case "empty_message":
      case "invalid_input":
      case "invalid_bot_id":
        return new HttpError("invalid_request", error.message, { cause: error });
      case "sandbox_failed":
      case "no_database_url":
        return new HttpError("unavailable", error.message, { cause: error });
      default:
        // bot_archived, unknown_model of an existing bot, conversation_unsupported, ...
        return new HttpError("conflict", error.message, { cause: error });
    }
  }
  if (error instanceof ApprovalError) {
    return new HttpError(error.code === "not_found" ? "not_found" : "conflict", error.message, {
      cause: error,
    });
  }
  if (error instanceof RuleError) {
    return new HttpError(error.code === "not_found" ? "not_found" : "conflict", error.message, {
      cause: error,
    });
  }
  if (error instanceof WrittenRuleError) {
    return new HttpError(error.code === "not_found" ? "not_found" : "conflict", error.message, {
      cause: error,
    });
  }
  if (error instanceof SecretNotFoundError) {
    return new HttpError("not_found", error.message, { cause: error });
  }
  if (error instanceof VaultError) {
    // A key that is not there is a problem of the server, not of the request.
    const unavailable = ["not_configured", "key_missing", "key_invalid", "key_unknown"];
    return new HttpError(
      error.code === "value_invalid"
        ? "invalid_request"
        : unavailable.includes(error.code)
          ? "unavailable"
          : "internal_error",
      error.message,
      { cause: error },
    );
  }
  if (error instanceof RunControlError) {
    return new HttpError(error.code === "not_found" ? "not_found" : "conflict", error.message, {
      cause: error,
    });
  }
  if (error instanceof ConversationNotFoundError || error instanceof RunNotFoundError) {
    return new HttpError("not_found", error.message, { cause: error });
  }
  if (error instanceof ConversationRuleError) {
    return new HttpError("conflict", error.message, { cause: error });
  }
  if (error instanceof ConfigError) {
    return new HttpError("unavailable", error.message, { cause: error });
  }
  const code = (error as { code?: string } | null)?.code;
  if (
    typeof code === "string" &&
    (DB_DOWN.has(code) || code.startsWith("08") || code === "57P01" || code === "57P03")
  ) {
    return new HttpError("unavailable", "O banco de dados não está respondendo.", { cause: error });
  }
  // Unique violations and the like that a handler did not expect.
  return new HttpError("internal_error", "Erro interno do servidor.", { cause: error });
}
