// Owns the rows of connectors (tables `connectors`, `connector_grants` and `connector_discovery`,
// migration 0012). The database holds configuration and REFERENCES to vault secrets by name, never a
// credential value. What is stored is validated by whoever writes it (the runtime, with the rules of
// `@suup/connectors`); this module only keeps it consistent and answers.
import { type OutboundMessage, outboundMessageSchema } from "@suup/core";
import { z } from "zod";
import type { Db } from "./client.js";

export const CONNECTOR_TRANSPORTS = ["stdio", "http"] as const;
export type ConnectorTransportKind = (typeof CONNECTOR_TRANSPORTS)[number];
export type ConnectorScopeName = "read_only" | "read_write";
export type ConnectorOrigin = "user" | "proposal";

export interface StoredConnector {
  id: string;
  name: string;
  description: string;
  transport: ConnectorTransportKind;
  command: string | null;
  args: string[];
  cwd: string | null;
  /** Name -> a plain string, or `{ secret, prefix? }` (a reference to the vault). */
  env: Record<string, unknown>;
  url: string | null;
  headers: Record<string, unknown>;
  scope: ConnectorScopeName;
  toolOverrides: Record<string, StoredToolOverride>;
  trustAnnotations: boolean;
  timeoutMs: number | null;
  enabled: boolean;
  origin: ConnectorOrigin;
  /** The bots that may use it (the bots that have a grant). */
  grantedBotIds: string[];
  /** What each of those bots may use: every tool, or the listed ones (names ON THE SERVER). */
  grants: ConnectorGrant[];
  createdAt: Date;
  updatedAt: Date;
}

/** What one bot may use of a connector. */
export interface ConnectorGrant {
  botId: string;
  /** Every tool the connector offers (and that is approved). When false, only `tools`. */
  all: boolean;
  /** The tools granted, by the name on the server (empty when `all`). */
  tools: string[];
}

/** A grant as a caller writes it: every tool, or an explicit list of tool names on the server. */
export type ToolGrantSpec = "all" | readonly string[];

/** What the user said about one tool: its risk and/or that it sends a message to another person. */
export interface StoredToolOverride {
  risk?: string | undefined;
  outbound?: OutboundMessage | undefined;
}

export interface ConnectorDiscovery {
  /** As the server described them (untrusted, bounded), or `null` when never read. */
  tools: unknown[] | null;
  discoveredAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

interface Row {
  id: string;
  name: string;
  description: string;
  transport: ConnectorTransportKind;
  command: string | null;
  args: unknown;
  cwd: string | null;
  env: unknown;
  url: string | null;
  headers: unknown;
  scope: ConnectorScopeName;
  tool_overrides: unknown;
  trust_annotations: boolean;
  timeout_ms: number | null;
  enabled: boolean;
  origin: ConnectorOrigin;
  granted: string[] | null;
  grants: { botId: string; all: boolean; tools: string[] }[] | null;
  created_at: Date;
  updated_at: Date;
}

const argsSchema = z.array(z.string());
const recordSchema = z.record(z.string(), z.unknown());
const overridesSchema = z.record(
  z.string(),
  z.object({ risk: z.string().optional(), outbound: outboundMessageSchema.optional() }),
);

function map(row: Row): StoredConnector {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: argsSchema.parse(row.args),
    cwd: row.cwd,
    env: recordSchema.parse(row.env),
    url: row.url,
    headers: recordSchema.parse(row.headers),
    scope: row.scope,
    toolOverrides: overridesSchema.parse(row.tool_overrides),
    trustAnnotations: row.trust_annotations,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled,
    origin: row.origin,
    grantedBotIds: row.granted ?? [],
    grants: (row.grants ?? []).map((g) => ({
      botId: g.botId,
      all: g.all,
      tools: g.all ? [] : [...g.tools],
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = (db: Db) => db.sql`
  select c.*,
         (select coalesce(array_agg(g.bot_id::text order by g.granted_at), '{}')
            from connector_grants g where g.connector_id = c.id) as granted,
         (select coalesce(json_agg(json_build_object('botId', g.bot_id::text, 'all', g.all_tools, 'tools', g.tools)
                                   order by g.granted_at), '[]'::json)
            from connector_grants g where g.connector_id = c.id) as grants
  from connectors c`;

export class ConnectorNameTakenError extends Error {
  override readonly name = "ConnectorNameTakenError";
  constructor(readonly connectorName: string) {
    super(`Já existe um conector chamado ${connectorName}.`);
  }
}

export class ConnectorNotFoundError extends Error {
  override readonly name = "ConnectorNotFoundError";
  constructor(readonly connectorName: string) {
    super(`Conector ${connectorName} não encontrado.`);
  }
}

export interface ConnectorWrite {
  name: string;
  description: string;
  transport: ConnectorTransportKind;
  command: string | null;
  args: string[];
  cwd: string | null;
  env: Record<string, unknown>;
  url: string | null;
  headers: Record<string, unknown>;
  scope: ConnectorScopeName;
  toolOverrides: Record<string, StoredToolOverride>;
  trustAnnotations: boolean;
  timeoutMs: number | null;
  enabled: boolean;
  origin: ConnectorOrigin;
}

export async function createConnector(db: Db, input: ConnectorWrite): Promise<StoredConnector> {
  const taken = await db.sql`select 1 from connectors where name = ${input.name}`;
  if (taken.length > 0) throw new ConnectorNameTakenError(input.name);
  await db.sql`
    insert into connectors (name, description, transport, command, args, cwd, env, url, headers, scope,
                            tool_overrides, trust_annotations, timeout_ms, enabled, origin)
    values (${input.name}, ${input.description}, ${input.transport}, ${input.command},
            ${db.sql.json(input.args)}, ${input.cwd}, ${db.sql.json(input.env as never)}, ${input.url},
            ${db.sql.json(input.headers as never)}, ${input.scope},
            ${db.sql.json(input.toolOverrides)}, ${input.trustAnnotations}, ${input.timeoutMs},
            ${input.enabled}, ${input.origin})`;
  const created = await getConnector(db, input.name);
  if (created === null) throw new Error("connector vanished after insert");
  return created;
}

export async function getConnector(db: Db, name: string): Promise<StoredConnector | null> {
  const [row] = await db.sql<Row[]>`${SELECT(db)} where c.name = ${name}`;
  return row === undefined ? null : map(row);
}

export async function listConnectors(db: Db): Promise<StoredConnector[]> {
  const rows = await db.sql<Row[]>`${SELECT(db)} order by c.name`;
  return rows.map(map);
}

/** Replaces the configuration of an existing connector (its name, grants and origin stay). */
export async function replaceConnector(
  db: Db,
  name: string,
  input: Omit<ConnectorWrite, "name" | "origin">,
): Promise<StoredConnector> {
  const rows = await db.sql`
    update connectors set
      description = ${input.description}, transport = ${input.transport}, command = ${input.command},
      args = ${db.sql.json(input.args)}, cwd = ${input.cwd}, env = ${db.sql.json(input.env as never)},
      url = ${input.url}, headers = ${db.sql.json(input.headers as never)}, scope = ${input.scope},
      tool_overrides = ${db.sql.json(input.toolOverrides)},
      trust_annotations = ${input.trustAnnotations}, timeout_ms = ${input.timeoutMs},
      enabled = ${input.enabled}
    where name = ${name} returning id`;
  if (rows.length === 0) throw new ConnectorNotFoundError(name);
  const updated = await getConnector(db, name);
  if (updated === null) throw new ConnectorNotFoundError(name);
  return updated;
}

export async function deleteConnector(db: Db, name: string): Promise<boolean> {
  const rows = await db.sql`delete from connectors where name = ${name} returning id`;
  return rows.length > 0;
}

/**
 * Lets the bot use the connector: every tool (`"all"`) or exactly the listed ones (names on the
 * server). Granting again REPLACES what the bot was granted. Throws `ConnectorNotFoundError`.
 */
export async function grantConnector(
  db: Db,
  name: string,
  botId: string,
  grant: ToolGrantSpec = "all",
): Promise<void> {
  const all = grant === "all";
  const tools = all ? [] : [...new Set(grant)].sort();
  const rows = await db.sql`
    insert into connector_grants (connector_id, bot_id, all_tools, tools)
    select id, ${z.uuid().parse(botId)}, ${all}, ${tools}::text[] from connectors where name = ${name}
    on conflict (connector_id, bot_id) do update set all_tools = excluded.all_tools, tools = excluded.tools
    returning connector_id`;
  if (rows.length === 0 && (await getConnector(db, name)) === null) {
    throw new ConnectorNotFoundError(name);
  }
}

/** Takes the permission away. Returns whether the bot had it. */
export async function revokeConnector(db: Db, name: string, botId: string): Promise<boolean> {
  const rows = await db.sql`
    delete from connector_grants
    where bot_id = ${z.uuid().parse(botId)}
      and connector_id = (select id from connectors where name = ${name})
    returning connector_id`;
  return rows.length > 0;
}

/** The enabled connectors a bot may use, in name order. */
export async function listConnectorsForBot(db: Db, botId: string): Promise<StoredConnector[]> {
  const rows = await db.sql<Row[]>`
    ${SELECT(db)}
    where c.enabled and exists (
      select 1 from connector_grants g where g.connector_id = c.id and g.bot_id = ${botId})
    order by c.name`;
  return rows.map(map);
}

export async function getConnectorDiscovery(
  db: Db,
  name: string,
): Promise<ConnectorDiscovery | null> {
  const [row] = await db.sql<
    {
      tools: unknown[] | null;
      discovered_at: Date | null;
      last_error: string | null;
      last_error_at: Date | null;
    }[]
  >`
    select d.tools, d.discovered_at, d.last_error, d.last_error_at
    from connectors c left join connector_discovery d on d.connector_id = c.id
    where c.name = ${name}`;
  if (row === undefined) return null;
  return {
    tools: row.tools,
    discoveredAt: row.discovered_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}

/** Saves what was seen of the server: the tools (success) or the error (failure). Not a configuration change. */
export async function saveConnectorDiscovery(
  db: Db,
  name: string,
  seen: { tools: unknown[] } | { error: string },
): Promise<void> {
  if ("tools" in seen) {
    await db.sql`
      insert into connector_discovery (connector_id, tools, discovered_at, last_error, last_error_at)
      select id, ${db.sql.json(seen.tools as never)}, now(), null, null from connectors where name = ${name}
      on conflict (connector_id) do update set
        tools = excluded.tools, discovered_at = excluded.discovered_at,
        last_error = null, last_error_at = null`;
  } else {
    await db.sql`
      insert into connector_discovery (connector_id, last_error, last_error_at)
      select id, ${seen.error.slice(0, 2000)}, now() from connectors where name = ${name}
      on conflict (connector_id) do update set
        last_error = excluded.last_error, last_error_at = excluded.last_error_at`;
  }
}
