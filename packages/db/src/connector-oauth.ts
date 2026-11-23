// Owns the rows of `connector_oauth` (migration 0028): what is known of a connector's OAuth login
// that is NOT a secret (public metadata, the registered client without its secret, the expiry and
// scope of the token, the redirect URI, the state and the last error). The tokens and the client
// secret are in the vault, never here.
import type { Db } from "./client.js";

export type ConnectorOAuthStatus = "needs_login" | "connected" | "error";

export interface ConnectorOAuthRow {
  status: ConnectorOAuthStatus;
  discovery: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  tokenInfo: Record<string, unknown> | null;
  redirectUri: string | null;
  lastError: string | null;
  updatedAt: Date;
}

interface Row {
  status: ConnectorOAuthStatus;
  discovery: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  token_info: Record<string, unknown> | null;
  redirect_uri: string | null;
  last_error: string | null;
  updated_at: Date;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function getConnectorOAuth(db: Db, name: string): Promise<ConnectorOAuthRow | null> {
  const [row] = await db.sql<Row[]>`
    select o.status, o.discovery, o.client, o.token_info, o.redirect_uri, o.last_error, o.updated_at
    from connector_oauth o join connectors c on c.id = o.connector_id
    where c.name = ${name}`;
  if (row === undefined) return null;
  return {
    status: row.status,
    discovery: asObject(row.discovery),
    client: asObject(row.client),
    tokenInfo: asObject(row.token_info),
    redirectUri: row.redirect_uri,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

/** Creates or replaces the row of the connector. Nothing happens when the connector is gone. */
export async function saveConnectorOAuth(
  db: Db,
  name: string,
  value: Omit<ConnectorOAuthRow, "updatedAt">,
): Promise<void> {
  const json = (v: Record<string, unknown> | null) => (v === null ? null : db.sql.json(v as never));
  await db.sql`
    insert into connector_oauth (connector_id, status, discovery, client, token_info, redirect_uri, last_error)
    select id, ${value.status}, ${json(value.discovery)}, ${json(value.client)}, ${json(value.tokenInfo)},
           ${value.redirectUri}, ${value.lastError === null ? null : value.lastError.slice(0, 2000)}
    from connectors where name = ${name}
    on conflict (connector_id) do update set
      status = excluded.status, discovery = excluded.discovery, client = excluded.client,
      token_info = excluded.token_info, redirect_uri = excluded.redirect_uri,
      last_error = excluded.last_error, updated_at = now()`;
}

/** Sets only the state and the last error (a refresh refused, a login that failed). */
export async function setConnectorOAuthStatus(
  db: Db,
  name: string,
  status: ConnectorOAuthStatus,
  lastError: string | null,
): Promise<void> {
  await db.sql`
    insert into connector_oauth (connector_id, status, last_error)
    select id, ${status}, ${lastError === null ? null : lastError.slice(0, 2000)}
    from connectors where name = ${name}
    on conflict (connector_id) do update set
      status = excluded.status, last_error = excluded.last_error, updated_at = now()`;
}

export async function deleteConnectorOAuth(db: Db, name: string): Promise<void> {
  await db.sql`
    delete from connector_oauth o using connectors c
    where c.id = o.connector_id and c.name = ${name}`;
}
