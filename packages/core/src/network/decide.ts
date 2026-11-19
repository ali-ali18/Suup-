// Owns the decision "may this subject open a connection to this host and port?", as a pure
// function: the same inputs always give the same answer, with no network and no database. The
// proxy asks it before it ever resolves a name.
import { normalizeHost } from "./host.js";

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

export type RefusalReason =
  | "not_allowed" // a well-formed name that is not on the list
  | "ip_literal" // the request named an address, never a name
  | "bad_host" // not a well-formed host name
  | "bad_port"; // a port outside the allowed ones

export type HostDecision =
  | { allow: true; host: string; port: number }
  | { allow: false; reason: RefusalReason; host: string; message: string };

export interface HostRequest {
  host: string;
  port: number;
}

/**
 * `allowed` holds exact, already normalised names. A request is allowed only when its normalised
 * host is IN that set (equality) and its port is in `ports`. No suffix, no wildcard, no pattern.
 */
export function decideHost(
  request: HostRequest,
  allowed: ReadonlySet<string>,
  ports: readonly number[] = DEFAULT_ALLOWED_PORTS,
): HostDecision {
  const normalized = normalizeHost(request.host);
  const shown = request.host.length > 120 ? `${request.host.slice(0, 120)}…` : request.host;
  if (normalized.kind === "ip") {
    return {
      allow: false,
      reason: "ip_literal",
      host: shown,
      message: `address ${shown} is refused: connections go to host names on the allowlist, never to IP addresses`,
    };
  }
  if (normalized.kind === "invalid") {
    return {
      allow: false,
      reason: "bad_host",
      host: shown,
      message: `host ${shown} is refused: it is not a valid host name`,
    };
  }
  if (!ports.includes(request.port)) {
    return {
      allow: false,
      reason: "bad_port",
      host: normalized.name,
      message: `port ${request.port} is not allowed (only ${ports.join(", ")})`,
    };
  }
  if (!allowed.has(normalized.name)) {
    return {
      allow: false,
      reason: "not_allowed",
      host: normalized.name,
      message: `host ${normalized.name} is not allowed for this bot`,
    };
  }
  return { allow: true, host: normalized.name, port: request.port };
}
