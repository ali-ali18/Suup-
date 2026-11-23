// Owns connectors as the rest of the system uses them: saving them (validated, with references to
// vault secrets), granting them to bots, checking them against the real server, and giving a run
// the tools of the connectors its bot may use. It sits between the rows (`@suup/db`), the protocol
// (`@suup/connectors`) and the vault; the loop and the tools know none of this.
import {
  adaptConnector,
  type CatalogEntry,
  ConnectorConfigError,
  ConnectorError,
  ConnectorManager,
  type ConnectorOAuthConfig,
  type ConnectorSpec,
  type ConnectorToolInfo,
  connectionOAuthProvider,
  connectorTag,
  type PinnedDefinition,
  parseConnectorSpec,
  pinnedDefinition,
  type RawTool,
  type StdioLauncher,
  secretNamesOf,
  type ToolOverride,
  toolFingerprint,
} from "@suup/connectors";
import type { OutboundMessage, RiskLevel, Tool } from "@suup/core";
import {
  approvePin,
  type ConnectorGrant,
  type ConnectorToolEvent,
  type ConnectorWrite,
  createConnector,
  type Db,
  deleteConnector,
  getBot,
  getConnector,
  getConnectorDiscovery,
  getConnectorOAuth,
  grantConnector,
  listConnectorEvents,
  listConnectors,
  listConnectorsForBot,
  listPins,
  PinNotFoundError,
  PinStaleError,
  type PinStatus,
  reconcilePins,
  replaceConnector,
  revokeConnector,
  type StoredConnector,
  saveConnectorDiscovery,
  type ToolPin,
} from "@suup/db";
import { RuntimeError } from "../errors.js";
import type { Vault } from "../vault/service.js";
import { type ConnectorGallery, createGallery } from "./gallery.js";
import { forgetOAuth, vaultOAuthStore } from "./oauth-store.js";
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

/** What a bot may use of a connector, as the API shows it. */
export type ConnectorGrantView = ConnectorGrant;

/** A grant as a person asks for it: every tool, or exactly these (names on the server). */
export type ToolSelection = "all" | readonly string[];

/** Where a tool stands with the pinning of its definition. `unseen`: never listed yet. */
export type ToolPinState = PinStatus | "unseen";

/** One tool of a connector, with the state of its pin. */
export interface ConnectorToolState extends ConnectorToolInfo {
  pin: ToolPinState;
  /** The fingerprint of the definition the server shows now (`null` when unseen). */
  fingerprint: string | null;
}

/** A tool waiting for a person to review its definition. */
export interface ConnectorToolReview {
  tool: string;
  /** `changed`: it was approved and the server now shows something else. `new`: never approved. */
  status: "changed" | "new";
  approvedFingerprint: string | null;
  approved: PinnedDefinition | null;
  currentFingerprint: string;
  current: PinnedDefinition;
  seenAt: Date;
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
  /** The gallery entry it was installed from (exact id), or `null`. */
  catalogId: string | null;
  /**
   * The OAuth login of an HTTP connector that uses one (never a token: only where it stands), or
   * `null` when the connector does not log in by OAuth.
   */
  oauth: {
    status: "needs_login" | "connected" | "error";
    lastError: string | null;
    /** When the access token stops working (it is renewed on its own while there is a refresh token). */
    expiresAt: Date | null;
  } | null;
  grantedBotIds: string[];
  /** What each bot with a grant may use. */
  grants: ConnectorGrantView[];
  /** The vault secrets it refers to. */
  secretNames: string[];
  /** Where a stdio server runs: isolated in a container, or as a program of the host (unisolated). `null` for HTTP. */
  runsIn: "container" | "host" | null;
  /** The state of this process's connection (a worker's or the server's own). */
  connection: { connected: boolean; failures: number; lastError: string | null };
  /** What was last seen of the server (by any process). */
  discovery: { discoveredAt: Date | null; lastError: string | null; lastErrorAt: Date | null };
  /** The tools, as the model would see them now, from the last listing; `null` when never listed. */
  tools: ConnectorToolState[] | null;
  /** How many tools wait for a review (changed or new): they are off for every bot. */
  pendingReviews: number;
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
  tools: ConnectorToolState[];
}

/** A connector tool the bot may use, described for the index of the tool search. */
export interface BotConnectorCandidate {
  /** The name in the registry. */
  name: string;
  /** The connector. */
  group: string;
  /** The connector as it appears in the tool names (`conn_<connector>`), as the model reads it. */
  prefix: string;
  /** What the server says the tool does (cleaned and bounded; untrusted). */
  summary: string;
}

export interface BotConnectorTools {
  tools: Tool[];
  /** The same tools, for the search index (parallel to `tools`). */
  candidates: BotConnectorCandidate[];
  /** Connectors whose tools could not be offered (and why), by name. */
  problems: { connector: string; message: string }[];
  /** Granted tools that are off until a person reviews their definition. */
  withheld: { connector: string; tool: string; reason: string }[];
}

export interface CreateOptions {
  origin?: "user" | "proposal";
  /** The gallery entry it comes from. */
  catalogId?: string;
  /**
   * The gallery installs an entry before its token is in the vault (the person types it next in
   * the secure form); the connector is created off and the missing secret is its status.
   */
  allowMissingSecrets?: boolean;
}

export interface ConnectorService {
  readonly manager: ConnectorManager;
  /** The gallery: entries, installing one, and the OAuth login in the browser. */
  readonly gallery: ConnectorGallery;
  list(): Promise<ConnectorView[]>;
  get(name: string): Promise<ConnectorView | null>;
  create(input: ConnectorInput, options?: CreateOptions): Promise<ConnectorView>;
  update(name: string, patch: ConnectorPatch): Promise<ConnectorView>;
  remove(name: string): Promise<boolean>;
  /** Replaces what the bot may use of the connector: every tool or exactly the listed ones. */
  grant(name: string, botId: string, tools: ToolSelection): Promise<ConnectorView>;
  revoke(name: string, botId: string): Promise<ConnectorView>;
  /** The tools whose definition changed (or that are new) and wait for a person. */
  review(name: string): Promise<ConnectorToolReview[]>;
  /**
   * The person approves the definition they looked at (`fingerprint`). If the tool changed again
   * meanwhile nothing is approved. Only the user can do this.
   */
  approveTool(name: string, tool: string, fingerprint: string): Promise<ConnectorView>;
  /** What happened to the pins of the connector, newest first. */
  events(name: string, limit?: number): Promise<ConnectorToolEvent[]>;
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
        : {
            kind: "http",
            url: c.url,
            headers: c.headers,
            ...(c.oauth === null ? {} : { oauth: c.oauth }),
          },
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
    oauth: t.kind === "http" && t.oauth !== undefined ? { ...t.oauth } : null,
  };
}

/** What is saved of a definition to show it later: bounded and cleaned like the stored listing. */
function storedDefinition(raw: RawTool): PinnedDefinition {
  const [bounded] = boundSnapshot([raw]);
  return pinnedDefinition(bounded ?? raw);
}

/** The tools with the state of their pins (by the exact name on the server). */
function withPins(
  info: readonly ConnectorToolInfo[],
  pins: ReadonlyMap<string, ToolPin>,
): ConnectorToolState[] {
  return info.map((t) => {
    const pin = pins.get(t.serverName);
    return {
      ...t,
      pin: pin === undefined ? "unseen" : pin.status,
      fingerprint: pin === undefined ? null : pin.seenFingerprint,
    };
  });
}

/** Whether the grant lets the bot use the tool (by the exact name on the server). */
export function grantAllows(grant: ConnectorGrant | undefined, serverTool: string): boolean {
  if (grant === undefined) return false;
  return grant.all || grant.tools.includes(serverTool);
}

export function createConnectorService(options: {
  db: () => Db;
  vault: Vault;
  fetch?: typeof fetch | undefined;
  /** Runs stdio servers isolated (docker sandbox). Absent: they are child processes of this one. */
  launcher?: StdioLauncher | undefined;
  /** The loopback listener of the OAuth login (tests): host and port. */
  oauthCallback?: { host?: string; port?: number } | undefined;
  /** The server's public address (`server.publicUrl`): the browser comes back there. */
  publicUrl?: string | undefined;
  /** How long a browser login waits for its callback (tests). */
  oauthFlowTtlMs?: number | undefined;
  /** The clock of the logins (tests). */
  now?: (() => number) | undefined;
  /** Another list of gallery entries (tests only: an entry that points at a fake OAuth server). */
  catalog?: readonly CatalogEntry[] | undefined;
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
    oauthProvider: async (spec) => {
      const oauth: ConnectorOAuthConfig | undefined =
        spec.transport.kind === "http" ? spec.transport.oauth : undefined;
      let clientSecret: string | undefined;
      if (oauth?.clientSecret !== undefined) {
        await vault.refresh(5_000);
        clientSecret = (await vault.resolveForConnector([oauth.clientSecret.secret]))[
          oauth.clientSecret.secret
        ];
      }
      return connectionOAuthProvider({
        store: vaultOAuthStore(db, vault, spec.name),
        clientName: "Suup",
        ...(oauth?.clientId === undefined
          ? {}
          : { preRegistered: { clientId: oauth.clientId, clientSecret } }),
      });
    },
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
    const pins = new Map((await listPins(db(), c.name)).map((p) => [p.tool, p]));
    const login = c.oauth === null ? null : await getConnectorOAuth(db(), c.name);
    const expiresIn = login?.tokenInfo?.expires_in;
    const obtainedAt = login?.tokenInfo?.obtainedAt;
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
      catalogId: c.catalogId,
      oauth:
        c.oauth === null
          ? null
          : {
              status: login?.status ?? "needs_login",
              lastError:
                login?.lastError === undefined || login.lastError === null
                  ? null
                  : vault.redactor.redact(login.lastError),
              expiresAt:
                typeof expiresIn === "number" && typeof obtainedAt === "number"
                  ? new Date(obtainedAt + expiresIn * 1000)
                  : null,
            },
      grantedBotIds: c.grantedBotIds,
      grants: c.grants,
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
      tools: raw === undefined ? null : withPins(adaptConnector(spec, raw, manager).info, pins),
      pendingReviews: [...pins.values()].filter((p) => p.status !== "approved").length,
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

  /** The tool names the connector is known to have (from pins or the stored listing), or `undefined`. */
  const knownToolNames = async (c: StoredConnector): Promise<Set<string> | undefined> => {
    const names = new Set((await listPins(db(), c.name)).map((p) => p.tool));
    for (const t of readSnapshot((await getConnectorDiscovery(db(), c.name))?.tools) ?? []) {
      names.add(t.name);
    }
    return names.size === 0 ? undefined : names;
  };

  /** Compares a live listing with the pins (writes them) and returns the pins by tool. */
  const reconcile = async (
    name: string,
    raw: readonly RawTool[],
  ): Promise<Map<string, ToolPin>> => {
    const { pins } = await reconcilePins(
      db(),
      name,
      raw.map((t) => ({
        tool: t.name,
        fingerprint: toolFingerprint(t),
        definition: storedDefinition(t),
      })),
    );
    return new Map(pins.map((p) => [p.tool, p]));
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

  const secretsReady = async (spec: ConnectorSpec): Promise<boolean> => {
    const names = secretNamesOf(spec);
    if (names.length === 0) return true;
    const have = new Set((await vault.list()).map((s) => s.name));
    return names.every((n) => have.has(n));
  };

  const asRuntimeError = (error: unknown): never => {
    if (error instanceof ConnectorConfigError) {
      throw new RuntimeError("invalid_input", error.message, { cause: error });
    }
    throw error;
  };

  let gallery: ConnectorGallery;
  const service: ConnectorService = {
    manager,
    get gallery() {
      return gallery;
    },
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
      if (opts.allowMissingSecrets !== true) await checkSecrets(spec);
      const origin = opts.origin ?? "user";
      try {
        const created = await createConnector(db(), {
          name: spec.name,
          origin,
          catalogId: opts.catalogId ?? null,
          ...writeOf(spec, {
            description: input.description ?? "",
            timeoutMs: input.timeoutMs ?? null,
            // A proposal is never live until a person approves it.
            enabled:
              origin === "proposal" ||
              (opts.allowMissingSecrets === true && !(await secretsReady(spec)))
                ? false
                : (input.enabled ?? true),
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
      const stored = await getConnector(db(), name);
      if (stored?.oauth !== null && stored?.oauth !== undefined) {
        // The login goes with the connector (the tokens leave the vault).
        await forgetOAuth(db, vault, name);
      }
      const gone = await deleteConnector(db(), name);
      await manager.invalidate(name);
      return gone;
    },
    async grant(name, botId, tools) {
      const connector = await must(name);
      if ((await getBot(db(), botId)) === null) {
        throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
      }
      if (tools !== "all") {
        let known = await knownToolNames(connector);
        if (known === undefined) {
          // Never listed: connect now, so the names can be checked and the definitions are pinned.
          const listed = await service.test(name);
          if (!listed.ok) {
            throw new RuntimeError(
              "invalid_input",
              `Não foi possível listar as ferramentas de ${name} para conferir a concessão: ${listed.error ?? "falhou"}`,
            );
          }
          known = await knownToolNames(connector);
        }
        const unknown = tools.filter((t) => known === undefined || !known.has(t));
        if (unknown.length > 0) {
          throw new RuntimeError(
            "invalid_input",
            `O conector ${name} não tem ${unknown.length === 1 ? "a ferramenta" : "as ferramentas"} ${unknown.join(", ")}. Veja as que ele tem: suup connectors tools ${name}`,
          );
        }
      }
      await grantConnector(db(), name, botId, tools);
      if (tools !== "all") {
        // Granting a tool the user can see is the moment its definition is pinned (a tool that
        // changed after it was approved still needs a review: granting it does not approve it).
        for (const pin of await listPins(db(), name)) {
          if (pin.status === "new" && tools.includes(pin.tool)) {
            await approvePin(db(), name, pin.tool, pin.seenFingerprint, "pinned_on_grant");
          }
        }
      }
      return view(await must(name));
    },
    async revoke(name, botId) {
      await must(name);
      await revokeConnector(db(), name, botId);
      return view(await must(name));
    },
    async review(name) {
      await must(name);
      const out: ConnectorToolReview[] = [];
      for (const pin of await listPins(db(), name)) {
        if (pin.status === "approved") continue;
        out.push({
          tool: pin.tool,
          status: pin.status,
          approvedFingerprint: pin.approvedFingerprint,
          approved: asDefinition(pin.approvedDefinition),
          currentFingerprint: pin.seenFingerprint,
          current: asDefinition(pin.seenDefinition) ?? emptyDefinition(pin.tool),
          seenAt: pin.seenAt,
        });
      }
      return out;
    },
    async approveTool(name, tool, fingerprint) {
      await must(name);
      try {
        await approvePin(db(), name, tool, fingerprint);
      } catch (error) {
        if (error instanceof PinNotFoundError) {
          throw new RuntimeError("connector_not_found", error.message, { cause: error });
        }
        if (error instanceof PinStaleError) {
          throw new RuntimeError("conflict", error.message, { cause: error });
        }
        throw error;
      }
      return view(await must(name));
    },
    events: async (name, limit) => {
      await must(name);
      return listConnectorEvents(db(), name, limit);
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
        const pins = await reconcile(name, report.tools);
        return {
          ok: true,
          serverName: report.serverName,
          serverVersion: report.serverVersion,
          durationMs: report.durationMs,
          error: null,
          tools: withPins(adaptConnector(spec, report.tools, manager).info, pins),
        };
      } catch (error) {
        const text = vault.redactor.redact(message(error));
        await saveConnectorDiscovery(db(), name, { error: text }).catch(() => {});
        return failure(error instanceof ConnectorError ? text : `Conector "${name}": ${text}`);
      }
    },
    async toolsForBot(botId) {
      const out: BotConnectorTools = { tools: [], candidates: [], problems: [], withheld: [] };
      const stored = await listConnectorsForBot(db(), botId);
      const adapted = await Promise.all(
        stored.map(async (c) => {
          try {
            const spec = specOf(c);
            const grant = c.grants.find((g) => g.botId === botId);
            let raw: RawTool[] | undefined;
            let pins: Map<string, ToolPin> | undefined;
            try {
              raw = await manager.tools(spec);
              pins = await reconcile(c.name, raw);
            } catch (error) {
              // Down right now: offer what was seen before, so a call fails as a clear tool error.
              // The stored listing is a cleaned copy, so it cannot be fingerprinted again: the
              // pins as they were saved decide.
              out.problems.push({
                connector: c.name,
                message: vault.redactor.redact(message(error)),
              });
              raw =
                manager.lastKnownTools(spec) ??
                readSnapshot((await getConnectorDiscovery(db(), c.name))?.tools);
              pins = new Map((await listPins(db(), c.name)).map((p) => [p.tool, p]));
            }
            if (raw === undefined) return undefined;
            const livePins = pins;
            const result = adaptConnector(spec, raw, manager, {
              include: (serverTool) => {
                if (!grantAllows(grant, serverTool)) {
                  return { ok: false, reason: "não concedida a este bot" };
                }
                const pin = livePins.get(serverTool);
                if (pin?.status !== "approved") {
                  const reason =
                    pin === undefined
                      ? "a definição ainda não foi vista (rode suup connectors test)"
                      : pin.status === "changed"
                        ? "a definição mudou depois de aprovada: revise (suup connectors review)"
                        : "ferramenta nova: revise e aprove (suup connectors review)";
                  out.withheld.push({ connector: c.name, tool: serverTool, reason });
                  return { ok: false, reason };
                }
                return { ok: true };
              },
            });
            return { connector: c.name, result };
          } catch (error) {
            out.problems.push({ connector: c.name, message: message(error) });
            return undefined;
          }
        }),
      );
      for (const a of adapted) {
        if (a === undefined) continue;
        const byName = new Map(a.result.info.map((i) => [i.name, i]));
        for (const tool of a.result.tools) {
          out.tools.push(tool);
          out.candidates.push({
            name: tool.name,
            group: a.connector,
            prefix: connectorTag(a.connector),
            summary: byName.get(tool.name)?.description ?? "",
          });
        }
      }
      return out;
    },
    close: async () => {
      await gallery.close();
      await manager.close();
    },
  };
  gallery = createGallery({
    db,
    vault,
    service,
    fetch: options.fetch,
    callback: options.oauthCallback,
    publicUrl: options.publicUrl,
    ...(options.oauthFlowTtlMs === undefined ? {} : { ttlMs: options.oauthFlowTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  return service;
}

function asDefinition(value: unknown): PinnedDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    name: typeof v.name === "string" ? v.name : "",
    description: typeof v.description === "string" ? v.description : null,
    inputSchema: v.inputSchema ?? null,
    annotations:
      typeof v.annotations === "object" && v.annotations !== null
        ? (v.annotations as PinnedDefinition["annotations"])
        : null,
  };
}

function emptyDefinition(name: string): PinnedDefinition {
  return { name, description: null, inputSchema: null, annotations: null };
}

function failure(error: string): ConnectorTestResult {
  return { ok: false, serverName: null, serverVersion: null, durationMs: 0, error, tools: [] };
}
