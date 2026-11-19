// Owns adapting a connector's tools to the `Tool` interface of `core`, so the registry, the
// approval gate, the vault and the untrusted-content labelling treat them exactly like a built-in
// tool: this module only DECLARES (the registered name, the risk, the input schema, that the output
// is external) and never decides anything about permissions. It does not know the database, the
// vault or the loop.
import { defineTool, type OutboundMessage, type RiskLevel, type Tool } from "@suup/core";
import type { z } from "zod";
import type { RawTool } from "./connection.js";
import { ConnectorError } from "./errors.js";
import type { ConnectorManager } from "./manager.js";
import { isRegistrable, registeredName } from "./names.js";
import { flattenResult } from "./result.js";
import { scopeAllows, type ToolRisk, toolRisk } from "./risk.js";
import { inputSchemaToZod, UnsupportedSchemaError } from "./schema.js";
import type { ConnectorSpec } from "./spec.js";
import { cleanDescription, clip, oneLineClean } from "./text.js";

export const MAX_TOOL_DESCRIPTION = 800;

/** What is known about one tool of a connector, for the model's registry and for the person's screens. */
export interface ConnectorToolInfo {
  /** The name on the server, cleaned for display. */
  tool: string;
  /** The name on the server, exactly as it came (what grants and pins are keyed by). */
  serverName: string;
  /** The name in the registry (what the model calls and what rules match). */
  name: string;
  description: string;
  risk: RiskLevel;
  riskBasis: ToolRisk["basis"];
  /** The user marked the tool as sending a message to another person (never a server's claim). */
  outbound?: OutboundMessage;
  /** Offered to bots. When not, `reason` says why. */
  available: boolean;
  reason?: string;
  /** The server's own hints, as reported (untrusted). */
  hints: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
}

export interface AdaptedConnector {
  tools: Tool[];
  info: ConnectorToolInfo[];
}

export interface AdaptOptions {
  /**
   * Which tools (by the exact name on the server) may be turned into `Tool`s. A tool that is not
   * included is still described in `info` (`available: false` and the reason), but no `Tool` is
   * made for it: for the bot it does not exist. Default: all.
   */
  include?(serverName: string): { ok: true } | { ok: false; reason: string };
}

/**
 * Turns the tools a server listed into registry tools and their descriptions. A tool that cannot
 * be offered (an input schema out of bounds, a name clash, hidden by the `read_only` scope) is left
 * out and reported in `info` with the reason; it never fails the connector.
 */
export function adaptConnector(
  spec: ConnectorSpec,
  discovered: readonly RawTool[],
  manager: Pick<ConnectorManager, "callTool">,
  options: AdaptOptions = {},
): AdaptedConnector {
  const tools: Tool[] = [];
  const info: ConnectorToolInfo[] = [];
  const taken = new Set<string>();
  for (const raw of discovered) {
    const name = registeredName(spec.name, raw.name);
    const risk = toolRisk(spec, raw.name, raw.annotations);
    const outbound = spec.tools[raw.name]?.outbound;
    const base: ConnectorToolInfo = {
      tool: oneLineClean(raw.name, 128),
      serverName: typeof raw.name === "string" ? raw.name : "",
      name,
      description: cleanDescription(raw.description, MAX_TOOL_DESCRIPTION),
      risk: risk.level,
      riskBasis: risk.basis,
      ...(outbound === undefined ? {} : { outbound }),
      available: false,
      hints: raw.annotations,
    };
    const skip = (reason: string) => info.push({ ...base, reason });

    if (typeof raw.name !== "string" || raw.name === "" || raw.name.length > 128) {
      skip("nome de ferramenta inválido");
      continue;
    }
    if (!isRegistrable(name) || taken.has(name)) {
      skip(
        taken.has(name)
          ? "outro nome da ferramenta do servidor resulta no mesmo nome"
          : "nome inválido",
      );
      continue;
    }
    if (raw.taskRequired) {
      skip("a ferramenta só roda como tarefa de longa duração, que este cliente não suporta");
      continue;
    }
    if (!scopeAllows(spec.scope, risk.level)) {
      skip(
        "escopo somente leitura: a ferramenta não está marcada como leitura (suup connectors set-risk … read)",
      );
      continue;
    }
    const included = options.include?.(raw.name);
    if (included !== undefined && !included.ok) {
      skip(included.reason);
      continue;
    }
    let input: z.ZodType<Record<string, unknown>>;
    try {
      input = inputSchemaToZod(raw.inputSchema);
    } catch (error) {
      skip(error instanceof UnsupportedSchemaError ? error.message : "esquema de entrada inválido");
      continue;
    }
    taken.add(name);
    info.push({ ...base, available: true });
    tools.push(
      makeTool(spec, raw.name, name, base.description, input, risk.level, outbound, manager),
    );
  }
  return { tools, info };
}

function makeTool(
  spec: ConnectorSpec,
  serverTool: string,
  name: string,
  description: string,
  input: z.ZodType<Record<string, unknown>>,
  level: RiskLevel,
  outbound: OutboundMessage | undefined,
  manager: Pick<ConnectorManager, "callTool">,
): Tool<Record<string, unknown>> {
  // The model is told where the tool comes from, in OUR words first; the server's follow, cleaned
  // and bounded. The server's text is data about the tool, not instructions to the model.
  const header = `Tool "${oneLineClean(serverTool, 80)}" of the external connector "${spec.name}".`;
  return defineTool<Record<string, unknown>>({
    name,
    description:
      description === "" ? header : `${header} Description given by the server: ${description}`,
    input,
    risk: level,
    classify: () => level,
    // Declared by the USER in the connector's settings, never taken from the server.
    ...(outbound === undefined ? {} : { outbound }),
    describe: (args) =>
      `Conector ${spec.name} → ${oneLineClean(serverTool, 80)} ${clip(safeJson(args), 300)}`,
    // Everything a server sends back is external content: the registry labels it as untrusted.
    externalOutput: true,
    // Our own timeout (inside the call) fires first and names the connector; this is the backstop.
    timeoutMs: spec.timeoutMs + 5_000,
    async execute(args, ctx) {
      try {
        const { result } = await manager.callTool(spec, serverTool, args, {
          signal: ctx.signal,
          timeoutMs: spec.timeoutMs,
        });
        const flat = flattenResult(result);
        return {
          content: flat.text === "" ? "(the connector returned no content)" : flat.text,
          ...(flat.isError ? { isError: true } : {}),
        };
      } catch (error) {
        if (error instanceof ConnectorError) {
          const unknownState =
            error.kind === "closed" || error.kind === "timeout"
              ? " The action may or may not have happened: check the state before repeating it."
              : "";
          return { content: `${error.message}${unknownState}`, isError: true };
        }
        throw error;
      }
    },
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}
