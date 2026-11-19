import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ServerConfigError } from "./errors.js";

/** The shortest token the server accepts. */
export const MIN_TOKEN_LENGTH = 32;

/** A new random token (256 bits, URL-safe). What `suup server --generate-token` prints. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Throws `ServerConfigError` (in Portuguese) unless the token is usable. */
export function assertToken(
  token: string | undefined,
  source = "o token",
): asserts token is string {
  if (token === undefined || token === "") {
    throw new ServerConfigError(
      `O servidor não sobe sem token: defina ${source} (gere um com: suup server --generate-token).`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ServerConfigError(
      `O token tem só ${token.length} caracteres e precisa ter pelo menos ${MIN_TOKEN_LENGTH} (gere um com: suup server --generate-token).`,
    );
  }
}

/**
 * Compares two strings in time that does not depend on where they differ, nor on their lengths:
 * both are hashed to a fixed size first and the hashes are compared with `timingSafeEqual`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** The token of an `Authorization: Bearer <token>` header, or `undefined`. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
  return match?.[1];
}

/** Whether the request carries the right token. */
export function isAuthorized(header: string | string[] | undefined, token: string): boolean {
  const given = bearerToken(header);
  // Always compare, even with nothing given, so a missing header costs the same as a wrong one.
  const ok = constantTimeEqual(given ?? "", token);
  return given !== undefined && ok;
}
