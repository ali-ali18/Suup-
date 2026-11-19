// Owns the names a connector's tools get in the registry. A server picks its own tool names (any
// string), but the registry and the providers accept `^[a-z][a-z0-9_]{0,63}$`, and two servers may
// use the same name, so each tool is registered as `conn_<connector>__<tool>`.
import { createHash } from "node:crypto";
import { TOOL_NAME_PATTERN } from "@suup/core";

/** A connector's name: lowercase words joined by single hyphens, up to 24 characters. */
export const CONNECTOR_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const CONNECTOR_NAME_MAX = 24;

export function isConnectorName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CONNECTOR_NAME_MAX &&
    CONNECTOR_NAME_PATTERN.test(value)
  );
}

export const TOOL_PREFIX = "conn_";
const SEPARATOR = "__";
const HASH_CHARS = 6;

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_CHARS);
}

/** The prefix every tool of the connector shares, e.g. `conn_gh__`. */
export function connectorPrefix(connector: string): string {
  return `${TOOL_PREFIX}${connector.replaceAll("-", "_")}${SEPARATOR}`;
}

/**
 * The registry name of `tool` on `connector`. Deterministic. A server name that already is a
 * plain `[a-z0-9_]` name that fits is used as it is; anything else (capitals, dashes, dots, too
 * long) is made plain and gets a short hash of the original, so two different server names can
 * never land on the same registered name.
 */
export function registeredName(connector: string, tool: string): string {
  const prefix = connectorPrefix(connector);
  const room = 64 - prefix.length;
  const plain = /^[a-z0-9_]+$/.test(tool);
  if (plain && tool.length <= room) return `${prefix}${tool}`;
  const body = tool
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = `_${hashOf(tool)}`;
  const kept = (body === "" ? "tool" : body).slice(0, room - suffix.length);
  return `${prefix}${kept}${suffix}`;
}

/** Whether the name is acceptable to the registry (always true for names this module makes). */
export function isRegistrable(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
