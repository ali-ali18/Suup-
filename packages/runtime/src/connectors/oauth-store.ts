// Owns where a connector's OAuth login is kept: the access token, the refresh token and the client
// secret in the VAULT (encrypted, known to the redactor the moment they are written, and marked
// `managed_by` that connector: they are the connector's own, never listed with the owner's
// secrets nor granted to a bot), everything
// else (public metadata, the client without its secret, expiry and scope) in `connector_oauth`.
// Nothing of it goes to the connector's configuration, an event, a log or an API response.
import type { OAuthStore, StoredOAuth } from "@suup/connectors";
import {
  type Db,
  deleteConnectorOAuth,
  getConnectorOAuth,
  saveConnectorOAuth,
  setConnectorOAuthStatus,
} from "@suup/db";
import type { Vault } from "../vault/service.js";

/** The vault names of a connector's login (`SUUP_OAUTH_<NAME>_ACCESS`, ...). */
export function oauthSecretNames(connector: string): {
  access: string;
  refresh: string;
  clientSecret: string;
} {
  const base = `SUUP_OAUTH_${connector.toUpperCase().replaceAll("-", "_")}`;
  return {
    access: `${base}_ACCESS`,
    refresh: `${base}_REFRESH`,
    clientSecret: `${base}_CLIENT_SECRET`,
  };
}

const description = (connector: string): string =>
  `Login OAuth do conector ${connector}, guardado pelo próprio conector.`;

type Json = Record<string, unknown>;

export function vaultOAuthStore(db: () => Db, vault: Vault, connector: string): OAuthStore {
  const names = oauthSecretNames(connector);
  /** The values as last read or written by this store (to skip writing what did not change). */
  let known: Record<string, string | undefined> = {};

  const readSecrets = async (): Promise<Record<string, string | undefined>> => {
    const have = new Set((await vault.list({ includeManaged: true })).map((s) => s.name));
    const wanted = Object.values(names).filter((n) => have.has(n));
    const values = wanted.length === 0 ? {} : await vault.resolveForConnector(wanted);
    known = { ...values };
    return values;
  };

  const put = async (name: string, value: string | undefined): Promise<void> => {
    if (known[name] === value) return;
    if (value === undefined) await vault.remove(name, { managedBy: connector });
    else
      await vault.set(name, value, { description: description(connector), managedBy: connector });
    known[name] = value;
  };

  return {
    async read(): Promise<StoredOAuth> {
      const row = await getConnectorOAuth(db(), connector);
      const secrets = await readSecrets();
      const out: StoredOAuth = {};
      if (row === null) return out;
      if (row.client !== null) {
        const secret = secrets[names.clientSecret];
        out.client = {
          ...(row.client as Json),
          ...(secret === undefined ? {} : { client_secret: secret }),
        } as StoredOAuth["client"];
      }
      const access = secrets[names.access];
      if (access !== undefined && row.tokenInfo !== null) {
        const refresh = secrets[names.refresh];
        out.tokens = {
          ...(row.tokenInfo as Json),
          access_token: access,
          ...(refresh === undefined ? {} : { refresh_token: refresh }),
        } as StoredOAuth["tokens"];
      }
      if (row.discovery !== null)
        out.discovery = row.discovery as unknown as StoredOAuth["discovery"];
      if (row.redirectUri !== null) out.redirectUri = row.redirectUri;
      return out;
    },
    async write(next: StoredOAuth): Promise<void> {
      const current = await getConnectorOAuth(db(), connector);
      if (Object.keys(known).length === 0) await readSecrets();
      const { access_token, refresh_token, ...tokenInfo } = next.tokens ?? {};
      const { client_secret, ...client } = (next.client ?? {}) as Json & {
        client_secret?: string;
      };
      await put(names.access, next.tokens === undefined ? undefined : access_token);
      await put(names.refresh, next.tokens === undefined ? undefined : refresh_token);
      await put(names.clientSecret, next.client === undefined ? undefined : client_secret);
      await saveConnectorOAuth(db(), connector, {
        status: next.tokens !== undefined ? "connected" : (current?.status ?? "needs_login"),
        discovery: (next.discovery as Json | undefined) ?? null,
        client: next.client === undefined ? null : client,
        tokenInfo: next.tokens === undefined ? null : (tokenInfo as Json),
        redirectUri: next.redirectUri ?? null,
        lastError: next.tokens !== undefined ? null : (current?.lastError ?? null),
      });
    },
    async loginRequired(reason: string): Promise<void> {
      await setConnectorOAuthStatus(db(), connector, "needs_login", reason);
    },
  };
}

/** Removes every trace of a connector's login: the vault secrets and the row. */
export async function forgetOAuth(db: () => Db, vault: Vault, connector: string): Promise<void> {
  const names = oauthSecretNames(connector);
  for (const name of Object.values(names)) await vault.remove(name, { managedBy: connector });
  await deleteConnectorOAuth(db(), connector);
}
