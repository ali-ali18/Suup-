// Owns the fingerprint of a connector tool's definition (research: "tool poisoning and rug pull").
// The fingerprint is the SHA-256 of a canonical serialisation (object keys sorted, no whitespace)
// of exactly what the server told us about the tool: name, description, input schema and
// annotations. Two fingerprints are compared for EQUALITY only; nothing here looks at what the
// text says. A server can still change what a tool DOES without changing this definition: that is
// outside what a hash can see (docs/CONECTORES.md).
import { createHash } from "node:crypto";
import type { RawTool } from "./connection.js";

/** The definition the fingerprint covers, as plain data (also what the review screen shows). */
export interface PinnedDefinition {
  name: string;
  description: string | null;
  inputSchema: unknown;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
}

export function pinnedDefinition(raw: RawTool): PinnedDefinition {
  return {
    name: raw.name,
    description: raw.description ?? null,
    inputSchema: raw.inputSchema ?? null,
    annotations: raw.annotations ?? null,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** The canonical text of a definition: the same definition always gives the same text. */
export function canonicalDefinition(def: PinnedDefinition): string {
  return JSON.stringify(sortKeys(def)) ?? "null";
}

/** Hex SHA-256 of the canonical definition. */
export function toolFingerprint(raw: RawTool): string {
  return createHash("sha256")
    .update(canonicalDefinition(pinnedDefinition(raw)))
    .digest("hex");
}
