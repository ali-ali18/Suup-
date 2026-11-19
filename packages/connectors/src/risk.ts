// Owns the risk level of a connector's tool and whether the tool is offered at all. The server's
// annotations (`readOnlyHint`, `destructiveHint`) are HINTS from a program the user did not write:
// they may make a call stricter, never looser, unless the user's own configuration says so
// (`tools.<name>.risk` for one tool, `trustAnnotations` for the whole connector).
import { maxRisk, type RiskLevel } from "@suup/core";
import type { ConnectorSpec } from "./spec.js";

/** The annotations of a tool as a server reports them (all optional, all untrusted). */
export interface ToolHints {
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
}

/** The safe default for a tool nobody vouched for: it asks. */
export const DEFAULT_CONNECTOR_RISK: RiskLevel = "external_irreversible";

/**
 * The least risk the hints themselves allow. A server that says it may change things (or does
 * not say it is read-only and does not deny being destructive) pushes the tool to
 * `external_irreversible`; one that only says "read-only" gives `read` (a floor of the lowest
 * level: it can only tighten, because the result is combined with `max`).
 */
export function hintFloor(hints: ToolHints | undefined): RiskLevel {
  if (hints === undefined) return "read";
  if (hints.destructiveHint === true) return "external_irreversible";
  if (hints.readOnlyHint === false) return "external_irreversible";
  return "read";
}

export interface ToolRisk {
  level: RiskLevel;
  /** Why, for `suup connectors tools`: where the level came from. */
  basis: "default" | "user" | "trusted_hint" | "tightened_by_hint" | "outbound";
}

/**
 * The effective level of one tool:
 *   - the user's own setting for the tool, else
 *   - `read` if (and only if) the user trusts the server's hints and the tool says it only reads, else
 *   - `external_irreversible`;
 * and then never less than what the hints imply (`max`), so a tool the user marked `read` that the
 * server now declares destructive asks again; and never `read` for a tool the user marked as
 * sending a message to another person.
 */
export function toolRisk(
  spec: Pick<ConnectorSpec, "tools" | "trustAnnotations">,
  tool: string,
  hints: ToolHints | undefined,
): ToolRisk {
  const own = spec.tools[tool]?.risk;
  let base: RiskLevel = DEFAULT_CONNECTOR_RISK;
  let basis: ToolRisk["basis"] = "default";
  if (own !== undefined) {
    base = own;
    basis = "user";
  } else if (
    spec.trustAnnotations &&
    hints?.readOnlyHint === true &&
    hints.destructiveHint !== true
  ) {
    base = "read";
    basis = "trusted_hint";
  }
  const level = maxRisk(base, hintFloor(hints));
  // A tool the user marked as sending a message to another person is never a read.
  if (
    spec.tools[tool]?.outbound !== undefined &&
    maxRisk(level, "external_irreversible") !== level
  ) {
    return { level: "external_irreversible", basis: "outbound" };
  }
  return { level, basis: level !== base ? "tightened_by_hint" : basis };
}

/** Whether the connector's scope lets the tool be offered: `read_only` keeps only tools that are `read`. */
export function scopeAllows(scope: ConnectorSpec["scope"], level: RiskLevel): boolean {
  return scope === "read_write" || level === "read";
}
