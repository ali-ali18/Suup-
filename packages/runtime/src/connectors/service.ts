// Owns connectors as the rest of the system uses them: saving them (validated, with references to
// vault secrets), granting them to bots, checking them against the real server, and giving a run
// the tools of the connectors its bot may use. It sits between the rows (`@suup/db`), the protocol
// (`@suup/connectors`) and the vault; the loop and the tools know none of this.
import {
  type AdaptedConnector,
  adaptConnector,
  ConnectorConfigError,
  ConnectorError,
  ConnectorManager,
  type ConnectorSpec,
  type ConnectorToolInfo,
  parseConnectorSpec,
  type RawTool,
  type StdioLauncher,
  secretNamesOf,
  type ToolOverride,
} from "@suup/connectors";
import type { OutboundMessage, RiskLevel, Tool } from "@suup/core";
import {
  type ConnectorWrite,
  createConnector,
  type Db,
  deleteConnector,
  getBot,
  getConnector,
  getConnectorDiscovery,
  grantConnector,
  listConnectors,
  listConnectorsForBot,
  replaceConnector,
  revokeConnector,
  type StoredConnector,
  saveConnectorDiscovery,
} from "@suup/db";
import { RuntimeError } from "../errors.js";
import type { Vault } from "../vault/service.js";
import { boundSnapshot, readSnapshot } from "./snapshot.js";

/** What a person (API, CLI) gives to create a connector; checked by the rules of `@suup/connectors`. */
export interface ConnectorInput {
  name: string;
  description?: string | undefined;
  transport: unknown;
  scope?: "read_only" | "read_write" | undefined;
  tools?: Record<string, ToolOverride> | undefined;
  trustAnnotations?: boolean | undefined;
  timeoutMs?: number | undefined;
  enabled?: boolean | undefined;
}

export interface ConnectorPatch {
  description?: string | undefined;
  transport?: unknown;
  scope?: "read_only" | "read_write" | undefined;
  tools?: Record<string, ToolOverride> | undefined;
  trustAnnotations?: boolean | undefined;
  /** `null` goes back to the default. */
  timeoutMs?: number | null | undefined;
  enabled?: boolean | undefined;
}

export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  /** The transport as configured: references to secrets by name, never values. */
  transport: ConnectorSpec["transport"];
  scope: "read_only" | "read_write";
  /** What the user said about each tool, by the name on the server. */
  toolOverrides: Record<string, ToolOverride>;
  trustAnnotations: boolean;
  timeoutMs: number;
  enabled: boolean;
  origin: "user" | "proposal";
  grantedBotIds: string[];
  /** The vault secrets it refers to. */
  secretNames: string[];
  /** Where a stdio server runs: isolated in a container, or as a program of the host (unisolated). `null` for HTTP. */
  runsIn: "container" | "host" | null;
  /** The state of this process's connection (a worker's or the server's own). */
  connection: { connected: boolean; failures: number; lastError: string | null };
  /** What was last seen of the server (by any process). */
  discovery: { discoveredAt: Date | null; lastError: string | null; lastErrorAt: Date | null };
  /** The tools, as the model would see them now, from the last listing; `null` when never listed. */
  tools: ConnectorToolInfo[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorTestResult {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  durationMs: number;
  /** A message for the person (names the connector), when it failed. */
  error: string | null;
  tools: ConnectorToolInfo[];
}

export interface BotConnectorTools {
  tools: Tool[];
  /** Connectors whose tools could not be offered (and why), by name. */
  problems: { connector: string; message: string }[];
}

export interface ConnectorService {
  readonly manager: ConnectorManager;
  list(): Promise<ConnectorView[]>;
  get(name: string): Promise<ConnectorView | null>;
  create(input: ConnectorInput, options?: { origin?: "user" | "proposal" }): Promise<ConnectorView>;
  update(name: string, patch: ConnectorPatch): Promise<ConnectorView>;
  remove(name: string): Promise<boolean>;
  grant(name: string, botId: string): Promise<ConnectorView>;
  revoke(name: string, botId: string): Promise<ConnectorView>;
  /** Sets (or, with `null`, clears) what the user says a tool's risk is. */
  setToolRisk(name: string, tool: string, risk: RiskLevel | null): Promise<ConnectorView>;
  /**
   * Sets (or, with `null`, clears) the user's statement that a tool sends a message to another
   * person, and where the recipient is in its arguments. Only the user says it, never the server.
   */
  setToolOutbound(
    name: string,
    tool: string,
    outbound: OutboundMessage | null,
  ): Promise<ConnectorView>;
  /** Connects from scratch, lists the tools and closes; saves what it saw. Never throws for a server problem. */
  test(name: string): Promise<ConnectorTestResult>;
  /** The tools the bot may use from its enabled connectors (connecting lazily). */
  toolsForBot(botId: string): Promise<BotConnectorTools>;
  close(): Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The overrides with one field of one tool set (`undefined` clears it); an override left empty goes away. */
function withOverride(
  current: Record<string, ToolOverride>,
  tool: string,
  change: ToolOverride,
): Record<string, ToolOverride> {
  const tools = { ...current };
  const merged: ToolOverride = { ...tools[tool] };
  if ("risk" in change) {
    if (change.risk === undefined) delete merged.risk;
    else merged.risk = change.risk;
  }
  if ("outbound" in change) {
    if (change.outbound === undefined) delete merged.outbound;
    else merged.outbound = change.outbound;
  }
  if (merged.risk === undefined && merged.outbound === undefined) delete tools[tool];
  else tools[tool] = merged;
  return tools;
}

export function specOf(c: StoredConnector): ConnectorSpec {
  return parseConnectorSpec({
    name: c.name,
    transport:
      c.transport === "stdio"
        ? {
            kind: "stdio",
            command: c.command,
            args: c.args,
            env: c.env,
            ...(c.cwd === null ? {} : { cwd: c.cwd }),
            egressHosts: c.egressHosts,
          }
        : { kind: "http", url: c.url, headers: c.headers },
    scope: c.scope,
    tools: c.toolOverrides,
    trustAnnotations: c.trustAnnotations,
    ...(c.timeoutMs === null ? {} : { timeoutMs: c.timeoutMs }),
    // Any change to the stored configuration changes `updated_at`: an older connection is dropped.
    version: c.updatedAt.toISOString(),
  });
}

function writeOf(
  spec: ConnectorSpec,
  extra: { description: string; timeoutMs: number | null; enabled: boolean },
): Omit<ConnectorWrite, "name" | "origin"> {
  const t = spec.transport;
  return {
    description: extra.description,
    transport: t.kind,
    command: t.kind === "stdio" ? t.command : null,
    args: t.kind === "stdio" ? t.args : [],
    cwd: t.kind === "stdio" ? (t.cwd ?? null) : null,
    env: t.kind === "stdio" ? t.env : {},
    url: t.kind === "http" ? t.url : null,
    headers: t.kind === "http" ? t.headers : {},
    scope: spec.scope,
    toolOverrides: spec.tools,
    trustAnnotations: spec.trustAnnotations,
    timeoutMs: extra.timeoutMs,
    enabled: extra.enabled,
    egressHosts: t.kind === "stdio" ? t.egressHosts : [],
  };
}

export function createConnectorService(options: {
  db: () => Db;
  vault: Vault;
  fetch?: typeof fetch | undefined;
  /** Runs stdio servers isolated (docker sandbox). Absent: they are child processes of this one. */
  launcher?: StdioLauncher | undefined;
  /** For tests of backoff and health checks. */
  managerOptions?: Partial<ConstructorParameters<typeof ConnectorManager>[0]> | undefined;
}): ConnectorService {
  const { vault } = options;
  const db = options.db;

  const manager = new ConnectorManager({
    resolveSecrets: async (names) => {
      await vault.refresh(5_000);
      return vault.resolveForConnector(names);
    },
    redact: (text) => vault.redactor.redact(text),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    ...(options.managerOptions ?? {}),
    onListed: (name, tools) => {
      void saveConnectorDiscovery(db(), name, { tools: boundSnapshot(tools) }).catch(() => {
        // the connector was removed meanwhile, or the database is busy: nothing depends on it
      });
    },
  });

  const view = async (c: StoredConnector): Promise<ConnectorView> => {
    const spec = specOf(c);
    const seen = await getConnectorDiscovery(db(), c.name);
    const raw = readSnapshot(seen?.tools) ?? manager.lastKnownTools(spec);
    const state = manager.status().find((s) => s.connector === c.name);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      transport: spec.transport,
      scope: spec.scope,
      toolOverrides: spec.tools,
      trustAnnotations: spec.trustAnnotations,
      timeoutMs: spec.timeoutMs,
      enabled: c.enabled,
      origin: c.origin,
      grantedBotIds: c.grantedBotIds,
      secretNames: secretNamesOf(spec),
      runsIn: spec.transport.kind === "stdio" ? manager.stdioIsolation : null,
      connection: {
        connected: state?.connected ?? false,
        failures: state?.failures ?? 0,
        lastError: state?.lastError ?? null,
      },
      discovery: {
        discoveredAt: seen?.discoveredAt ?? null,
        lastError:
          seen?.lastError === undefined || seen.lastError === null
            ? null
            : vault.redactor.redact(seen.lastError),
        lastErrorAt: seen?.lastErrorAt ?? null,
      },
      tools: raw === undefined ? null : adaptConnector(spec, raw, manager).info,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  };

  const must = async (name: string): Promise<StoredConnector> => {
    const found = await getConnector(db(), name);
    if (found === null) {
      throw new RuntimeError("connector_not_found", `Conector ${name} não encontrado.`);
    }
    return found;
  };

  /** A connector may only refer to vault secrets that exist (a typo would fail at the first run). */
  const checkSecrets = async (spec: ConnectorSpec): Promise<void> => {
    const names = secretNamesOf(spec);
    if (names.length === 0) return;
    const have = new Set((await vault.list()).map((s) => s.name));
    const missing = names.filter((n) => !have.has(n));
    if (missing.length > 0) {
      throw new RuntimeError(
        "invalid_input",
        `O conector usa ${missing.length === 1 ? "o segredo" : "os segredos"} ${missing.join(", ")}, que não ${missing.length === 1 ? "existe" : "existem"} no cofre. Cadastre antes: suup vault set ${missing[0]}`,
      );
    }
  };

  const asRuntimeError = (error: unknown): never => {
    if (error instanceof ConnectorConfigError) {
      throw new RuntimeError("invalid_input", error.message, { cause: error });
    }
    throw error;
  };

  const service: ConnectorService = {
    manager,
    async list() {
      return Promise.all((await listConnectors(db())).map(view));
    },
    async get(name) {
      const found = await getConnector(db(), name);
      return found === null ? null : view(found);
    },
    async create(input, opts = {}) {
      let spec: ConnectorSpec;
      try {
        spec = parseConnectorSpec({
          name: input.name,
          transport: input.transport,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.trustAnnotations === undefined
            ? {}
            : { trustAnnotations: input.trustAnnotations }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
      } catch (error) {
        return asRuntimeError(error);
      }
      await checkSecrets(spec);
      const origin = opts.origin ?? "user";
      try {
        const created = await createConnector(db(), {
          name: spec.name,
          origin,
          ...writeOf(spec, {
            description: input.description ?? "",
            timeoutMs: input.timeoutMs ?? null,
            // A proposal is never live until a person approves it.
            enabled: origin === "proposal" ? false : (input.enabled ?? true),
          }),
        });
        return await view(created);
      } catch (error) {
        if (error instanceof Error && error.name === "ConnectorNameTakenError") {
          throw new RuntimeError("conflict", error.message, { cause: error });
        }
        throw error;
      }
    },
    async update(name, patch) {
      const current = await must(name);
      const base = specOf(current);
      let spec: ConnectorSpec;
      try {
        spec = parseConnectorSpec({
          ...base,
          transport: patch.transport ?? base.transport,
          scope: patch.scope ?? base.scope,
          tools: patch.tools ?? base.tools,
          trustAnnotations: patch.trustAnnotations ?? base.trustAnnotations,
          ...(patch.timeoutMs === null
            ? { timeoutMs: undefined }
            : { timeoutMs: patch.timeoutMs ?? current.timeoutMs ?? undefined }),
        });
      } catch (error) {
        return asRuntimeError(error);
      }
      await checkSecrets(spec);
      const saved = await replaceConnector(
        db(),
        name,
        writeOf(spec, {
          description: patch.description ?? current.description,
          timeoutMs: patch.timeoutMs === null ? null : (patch.timeoutMs ?? current.timeoutMs),
          enabled: patch.enabled ?? current.enabled,
        }),
      );
      await manager.invalidate(name);
      return view(saved);
    },
    async remove(name) {
      const gone = await deleteConnector(db(), name);
      await manager.invalidate(name);
      return gone;
    },
    async grant(name, botId) {
      await must(name);
      if ((await getBot(db(), botId)) === null) {
        throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
      }
      await grantConnector(db(), name, botId);
      return view(await must(name));
    },
    async revoke(name, botId) {
      await must(name);
      await revokeConnector(db(), name, botId);
      return view(await must(name));
    },
    async setToolRisk(name, tool, risk) {
      const current = await must(name);
      return service.update(name, {
        tools: withOverride(specOf(current).tools, tool, { risk: risk ?? undefined }),
      });
    },
    async setToolOutbound(name, tool, outbound) {
      const current = await must(name);
      return service.update(name, {
        tools: withOverride(specOf(current).tools, tool, { outbound: outbound ?? undefined }),
      });
    },
    async test(name) {
      const stored = await must(name);
      let spec: ConnectorSpec;
      try {
        spec = specOf(stored);
      } catch (error) {
        return failure(message(error));
      }
      try {
        const report = await manager.test(spec);
        return {
          ok: true,
          serverName: report.serverName,
          serverVersion: report.serverVersion,
          durationMs: report.durationMs,
          error: null,
          tools: adaptConnector(spec, report.tools, manager).info,
        };
      } catch (error) {
        const text = vault.redactor.redact(message(error));
        await saveConnectorDiscovery(db(), name, { error: text }).catch(() => {});
        return failure(error instanceof ConnectorError ? text : `Conector "${name}": ${text}`);
      }
    },
    async toolsForBot(botId) {
      const out: BotConnectorTools = { tools: [], problems: [] };
      const stored = await listConnectorsForBot(db(), botId);
      const adapted = await Promise.all(
        stored.map(async (c): Promise<AdaptedConnector | undefined> => {
          try {
            const spec = specOf(c);
            let raw: RawTool[] | undefined;
            try {
              raw = await manager.tools(spec);
            } catch (error) {
              // Down right now: offer what was seen before, so a call fails as a clear tool error.
              out.problems.push({
                connector: c.name,
                message: vault.redactor.redact(message(error)),
              });
              raw =
                manager.lastKnownTools(spec) ??
                readSnapshot((await getConnectorDiscovery(db(), c.name))?.tools);
            }
            return raw === undefined ? undefined : adaptConnector(spec, raw, manager);
          } catch (error) {
            out.problems.push({ connector: c.name, message: message(error) });
            return undefined;
          }
        }),
      );
      for (const a of adapted) if (a !== undefined) out.tools.push(...a.tools);
      return out;
    },
    close: () => manager.close(),
  };
  return service;
}

function failure(error: string): ConnectorTestResult {
  return { ok: false, serverName: null, serverVersion: null, durationMs: 0, error, tools: [] };
}
