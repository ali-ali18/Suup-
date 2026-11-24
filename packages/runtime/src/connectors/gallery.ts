// Owns the gallery of connectors as the person uses it: the list of entries with where each one
// stands (installed? logged in? waiting for a token?), installing an entry (always the transport
// the entry declares, never a command from anyone else), and the browser login of the OAuth of the
// MCP protocol: where the browser comes back, the single-use `state` with a short life, the code
// exchange and the tokens in the vault.
//
// Where the browser comes back (docs/CONECTORES.md, "OAuth"):
// - no public address (the app on the person's computer): a loopback listener in THIS process,
//   `http://127.0.0.1:<port>/callback`; the browser and the server are on the same machine.
// - `server.publicUrl` set (a VPS with its HTTPS address): the server's own route
//   `<publicUrl>/oauth/callback` (no token: the single-use `state` is what protects it).
// Both run exactly the same checks (`callback`). A VPS without a public address cannot receive the
// browser: the app says so and the person uses a token entry (the owner: "por que raios eu colaria
// um link?": there is no paste step).
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  beginOAuthLogin,
  type CatalogEntry,
  CONNECTOR_CATALOG,
  catalogToolOverrides,
  completeOAuthLogin,
  type PendingLogin,
  revokeOAuth,
} from "@suup/connectors";
import { type Db, getConnector, getConnectorOAuth, setConnectorOAuthStatus } from "@suup/db";
import { RuntimeError } from "../errors.js";
import { VaultError } from "../vault/crypto.js";
import type { Vault } from "../vault/service.js";
import { forgetOAuth, vaultOAuthStore } from "./oauth-store.js";
import type { ConnectorService, ConnectorView } from "./service.js";

/** Where an entry of the gallery stands for this person. */
export type CatalogStatus =
  /** Not installed; it can be. */
  | "available"
  /** Shown for what it is, but it cannot be installed yet (`unverifiedReason`). */
  | "unverified"
  /** Installed; the OAuth login is missing (or expired). */
  | "needs_login"
  /** Installed; its token is not in the vault yet. */
  | "needs_secret"
  /** Installed, logged in and on. */
  | "connected"
  /** Installed with its credentials, but turned off. */
  | "off"
  /** The last login or connection failed (`detail` says why). */
  | "error";

export interface CatalogItem {
  entry: CatalogEntry;
  status: CatalogStatus;
  /** The installed connector's name, or `null`. */
  connector: string | null;
  /** Why it failed, or what is missing, in words for the person. */
  detail: string | null;
  /** A browser login of this connector waiting for its callback, if any. */
  login: { flowId: string; expiresAt: Date } | null;
}

export interface InstallResult {
  item: CatalogItem;
  /** What the person still has to do: log in (OAuth), give the token (secure form), or nothing. */
  next: "login" | "secret" | "none";
}

export type OAuthLoginStatus = "none" | "pending" | "connected" | "needs_login" | "error";

export interface OAuthStatusView {
  status: OAuthLoginStatus;
  /** The login waiting for its callback (while `pending`). */
  flowId: string | null;
  expiresAt: Date | null;
  error: string | null;
}

export interface OAuthStartResult {
  /** Open it in the person's browser. */
  authorizationUrl: string;
  flowId: string;
  /** Where the browser comes back (the loopback listener, or the server's public route). */
  redirectUri: string;
  expiresAt: Date;
}

export interface ConnectorGallery {
  list(): Promise<CatalogItem[]>;
  /**
   * Creates the connector of the entry (off until its credentials are there), or turns an
   * installed one on when its token is now in the vault. `proposal`: a bot proposed it on an
   * approved card; it stays off until the person logs in.
   */
  install(id: string, options?: { origin?: "user" | "proposal" }): Promise<InstallResult>;
  oauthStart(connector: string): Promise<OAuthStartResult>;
  oauthStatus(connector: string): Promise<OAuthStatusView>;
  /**
   * Where the browser comes back: `loopback` (this computer only) or `public` (the server's public
   * address, `server.publicUrl`).
   */
  readonly redirect: "loopback" | "public";
  /**
   * The browser came back to the server's public route (`OAUTH_CALLBACK_PATH`) with these query
   * parameters: the page to show it. `undefined` when the server has no public address.
   */
  publicCallback(params: URLSearchParams): Promise<CallbackPage | undefined>;
  /** Revokes (when the server can), forgets the tokens and turns the connector off. */
  oauthDisconnect(connector: string): Promise<ConnectorView>;
  close(): Promise<void>;
}

/** What the browser is shown when it comes back: a status and a short page in words. */
export interface CallbackPage {
  status: number;
  html: string;
}

/** The server's own route the browser comes back to when `server.publicUrl` is set. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/** How long a login waits for the browser to come back. */
export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** The name the client gives itself to every authorization server: always its own. */
export const OAUTH_CLIENT_NAME = "Suup";

interface Flow {
  id: string;
  connector: string;
  pending: PendingLogin;
  expiresAt: number;
  status: "pending" | "connected" | "error";
  error: string | null;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function createGallery(deps: {
  db: () => Db;
  vault: Vault;
  service: ConnectorService;
  fetch?: typeof fetch | undefined;
  /** The loopback listener: host and port (0: a free port, kept for the life of the process). */
  callback?: { host?: string; port?: number } | undefined;
  /**
   * The server's public address (`server.publicUrl`, already checked: HTTPS, or a loopback host):
   * the browser comes back to `<publicUrl>/oauth/callback` instead of the loopback listener.
   */
  publicUrl?: string | undefined;
  now?: () => number;
  ttlMs?: number;
  /**
   * The entries of the gallery. Default: the owner's list (`CONNECTOR_CATALOG`). Only tests pass
   * another (an entry that points at a fake OAuth server), never the configuration.
   */
  catalog?: readonly CatalogEntry[] | undefined;
}): ConnectorGallery {
  const { db, vault, service } = deps;
  const catalog = deps.catalog ?? CONNECTOR_CATALOG;
  const catalogEntry = (id: string): CatalogEntry | undefined => catalog.find((e) => e.id === id);
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const flows = new Map<string, Flow>();
  const byState = new Map<string, string>();
  let listener: { server: Server; base: string } | undefined;
  let opening: Promise<{ server: Server; base: string }> | undefined;

  const sweep = (): void => {
    for (const [id, flow] of flows) {
      if (flow.status === "pending" && flow.expiresAt <= now()) {
        byState.delete(flow.pending.state);
        flow.status = "error";
        flow.error = "o login expirou antes de o navegador voltar: clique em Conectar de novo";
      }
      // Finished flows are kept a little for the status, then go.
      if (flow.status !== "pending" && flow.expiresAt + OAUTH_FLOW_TTL_MS <= now())
        flows.delete(id);
    }
  };

  const latestFlow = (connector: string): Flow | undefined => {
    sweep();
    let found: Flow | undefined;
    for (const flow of flows.values()) {
      if (
        flow.connector === connector &&
        (found === undefined || flow.expiresAt > found.expiresAt)
      ) {
        found = flow;
      }
    }
    return found;
  };

  const message = (error: unknown): string =>
    vault.redactor.redact(error instanceof Error ? error.message : String(error));

  /** Runs the checks and the exchange for a flow whose `state` was just used up. */
  const finish = async (flow: Flow, params: URLSearchParams): Promise<void> => {
    try {
      await completeOAuthLogin(flow.pending, params);
      flow.status = "connected";
      flow.error = null;
      const stored = await getConnector(db(), flow.connector);
      if (stored !== null && !stored.enabled) {
        await service.update(flow.connector, { enabled: true });
      } else {
        await service.manager.invalidate(flow.connector);
      }
      // The first listing pins the definitions (the baseline) and shows the tools in the app.
      void service.test(flow.connector).catch(() => {});
    } catch (error) {
      flow.status = "error";
      flow.error = message(error);
      await setConnectorOAuthStatus(db(), flow.connector, "error", flow.error).catch(() => {});
    }
  };

  /**
   * Takes the flow of this `state` out (single use), or says why there is none. `arrivedAt`: the
   * address the browser came back to, which must be the redirect URI of THAT login (a login started
   * for the loopback is not finished by the public route, nor the other way round).
   */
  const takeByState = (state: string | null, arrivedAt: string): Flow | string => {
    sweep();
    if (state === null) return "o retorno do login não trouxe o parâmetro state";
    const id = byState.get(state);
    const flow = id === undefined ? undefined : flows.get(id);
    if (flow === undefined || flow.status !== "pending") {
      byState.delete(state);
      return "este login não vale mais (expirou ou já foi usado): volte ao Suup e clique em Conectar de novo";
    }
    if (flow.pending.redirectUri !== arrivedAt) {
      return "este retorno chegou a um endereço diferente do que o login pediu: volte ao Suup e clique em Conectar de novo";
    }
    byState.delete(state);
    return flow;
  };

  const page = (status: number, title: string, text: string): CallbackPage => ({
    status,
    html: PAGE(title, escapeHtml(text)),
  });

  /** The same checks wherever the browser came back: the state (once), the issuer, the exchange. */
  const callback = async (params: URLSearchParams, arrivedAt: string): Promise<CallbackPage> => {
    const taken = takeByState(params.get("state"), arrivedAt);
    if (typeof taken === "string") return page(400, "Login não concluído", taken);
    await finish(taken, params);
    return taken.status === "connected"
      ? page(200, "Pronto", "Login feito. Pode fechar esta página e voltar ao Suup.")
      : page(400, "Login não concluído", taken.error ?? "o login falhou");
  };

  const publicRedirect =
    deps.publicUrl === undefined ? undefined : `${deps.publicUrl}${OAUTH_CALLBACK_PATH}`;

  const openListener = async (): Promise<{ server: Server; base: string }> => {
    if (listener !== undefined) return listener;
    opening ??= (async () => {
      const host = deps.callback?.host ?? "127.0.0.1";
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://callback.invalid");
        if (req.method !== "GET" || url.pathname !== "/callback") {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("não encontrado");
          return;
        }
        void (async () => {
          const { base } = listener ?? { base: "" };
          const answer = await callback(url.searchParams, `${base}/callback`);
          res
            .writeHead(answer.status, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            })
            .end(answer.html);
        })();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(deps.callback?.port ?? 0, host, () => resolve());
      });
      server.unref();
      const { port } = server.address() as AddressInfo;
      listener = { server, base: `http://127.0.0.1:${port}` };
      return listener;
    })();
    try {
      return await opening;
    } finally {
      opening = undefined;
    }
  };

  const oauthConfigOf = async (connector: string) => {
    const view = await service.get(connector);
    if (view === null) {
      throw new RuntimeError("connector_not_found", `Conector ${connector} não encontrado.`);
    }
    if (view.transport.kind !== "http" || view.transport.oauth === undefined) {
      throw new RuntimeError(
        "invalid_input",
        `O conector ${connector} não entra por OAuth (usa um token ou um programa local).`,
      );
    }
    return { view, url: view.transport.url, oauth: view.transport.oauth };
  };

  const statusOf = async (connector: string): Promise<OAuthStatusView> => {
    const view = await service.get(connector);
    if (view === null) {
      throw new RuntimeError("connector_not_found", `Conector ${connector} não encontrado.`);
    }
    if (view.transport.kind !== "http" || view.transport.oauth === undefined) {
      return { status: "none", flowId: null, expiresAt: null, error: null };
    }
    const flow = latestFlow(connector);
    if (flow?.status === "pending") {
      return {
        status: "pending",
        flowId: flow.id,
        expiresAt: new Date(flow.expiresAt),
        error: null,
      };
    }
    if (flow?.status === "error") {
      // The last login of this process failed (expired, refused): that is the news.
      return { status: "error", flowId: flow.id, expiresAt: null, error: flow.error };
    }
    const row = await getConnectorOAuth(db(), connector);
    const status: OAuthLoginStatus =
      row === null ? "needs_login" : row.status === "connected" ? "connected" : row.status;
    return {
      status,
      flowId: null,
      expiresAt: null,
      error:
        row?.lastError === undefined || row.lastError === null
          ? null
          : vault.redactor.redact(row.lastError),
    };
  };

  const itemOf = async (
    entry: CatalogEntry,
    views: ConnectorView[],
    secrets: Set<string>,
  ): Promise<CatalogItem> => {
    const view = views.find((v) => v.catalogId === entry.id);
    if (view === undefined) {
      return {
        entry,
        status: entry.availability === "ready" ? "available" : "unverified",
        connector: null,
        detail: entry.availability === "ready" ? null : (entry.unverifiedReason ?? null),
        login: null,
      };
    }
    const base = { entry, connector: view.name, login: null };
    const failed = (): string | null => {
      const d = view.discovery;
      if (d.lastError === null || d.lastErrorAt === null) return null;
      return d.discoveredAt !== null && d.discoveredAt > d.lastErrorAt ? null : d.lastError;
    };
    if (entry.auth.kind === "oauth") {
      const oauth = await statusOf(view.name);
      if (oauth.status === "pending") {
        return {
          ...base,
          status: "needs_login",
          detail: null,
          login:
            oauth.flowId === null || oauth.expiresAt === null
              ? null
              : { flowId: oauth.flowId, expiresAt: oauth.expiresAt },
        };
      }
      if (oauth.status === "error") return { ...base, status: "error", detail: oauth.error };
      if (oauth.status !== "connected")
        return { ...base, status: "needs_login", detail: oauth.error };
    } else if (entry.auth.kind === "token") {
      if (!secrets.has(entry.auth.secret)) {
        return {
          ...base,
          status: "needs_secret",
          detail: `Falta o token ${entry.auth.secret} no cofre.`,
        };
      }
    }
    if (!view.enabled) return { ...base, status: "off", detail: null };
    const error = failed();
    return error === null
      ? { ...base, status: "connected", detail: null }
      : { ...base, status: "error", detail: error };
  };

  const gallery: ConnectorGallery = {
    async list() {
      const views = await service.list();
      const secrets = new Set((await vault.list()).map((s) => s.name));
      return Promise.all(catalog.map((e) => itemOf(e, views, secrets)));
    },
    async install(id, options = {}) {
      const entry = catalogEntry(id);
      if (entry === undefined) {
        throw new RuntimeError("connector_not_found", `A galeria não tem o conector ${id}.`);
      }
      if (entry.availability !== "ready" || entry.transport === null) {
        throw new RuntimeError(
          "conflict",
          `${entry.name} ainda não pode ser instalado: ${entry.unverifiedReason ?? "não verificado"}`,
        );
      }
      const origin = options.origin ?? "user";
      const secrets = new Set((await vault.list()).map((s) => s.name));
      const hasSecret = entry.auth.kind === "token" && secrets.has(entry.auth.secret);
      const existing = await getConnector(db(), entry.id);
      if (existing !== null && existing.catalogId !== entry.id) {
        throw new RuntimeError(
          "conflict",
          `Já existe um conector chamado ${entry.id} que não veio da galeria: renomeie ou remova antes.`,
        );
      }
      if (existing === null) {
        const transport =
          entry.auth.kind === "oauth" && entry.transport.kind === "http"
            ? {
                ...entry.transport,
                oauth: entry.auth.scopes === undefined ? {} : { scopes: [...entry.auth.scopes] },
              }
            : entry.transport;
        await service.create(
          {
            name: entry.id,
            description: entry.description,
            transport,
            tools: catalogToolOverrides(entry),
            // A token already in the vault: the person clicked Conectar, it is on at once.
            enabled: origin === "user" && hasSecret,
          },
          { origin, catalogId: entry.id, allowMissingSecrets: true },
        );
      } else if (origin === "user" && hasSecret && !existing.enabled) {
        // The token arrived after the install (the secure form): now it can be on.
        await service.update(entry.id, { enabled: true });
      }
      const views = await service.list();
      const item = await itemOf(entry, views, new Set((await vault.list()).map((s) => s.name)));
      const next =
        item.status === "needs_login"
          ? "login"
          : item.status === "needs_secret"
            ? "secret"
            : "none";
      return { item, next };
    },
    async oauthStart(connector) {
      const { url, oauth } = await oauthConfigOf(connector);
      // A login of this connector still waiting is replaced: its `state` stops being valid.
      for (const flow of flows.values()) {
        if (flow.connector === connector && flow.status === "pending") {
          byState.delete(flow.pending.state);
          flow.status = "error";
          flow.error = "substituído por um login mais novo";
        }
      }
      const redirectUri = publicRedirect ?? `${(await openListener()).base}/callback`;
      let clientSecret: string | undefined;
      if (oauth.clientSecret !== undefined) {
        clientSecret = (await vault.resolveForConnector([oauth.clientSecret.secret]))[
          oauth.clientSecret.secret
        ];
      }
      let pending: PendingLogin;
      try {
        pending = await beginOAuthLogin({
          serverUrl: url,
          store: vaultOAuthStore(db, vault, connector),
          redirectUri,
          clientName: OAUTH_CLIENT_NAME,
          scopes: oauth.scopes,
          ...(oauth.clientId === undefined
            ? {}
            : { preRegistered: { clientId: oauth.clientId, clientSecret } }),
          fetch: deps.fetch,
          now,
        });
      } catch (error) {
        // The vault without its key is the server's problem, not the request's (503).
        if (error instanceof VaultError) throw error;
        const text = message(error);
        await setConnectorOAuthStatus(db(), connector, "error", text).catch(() => {});
        throw new RuntimeError("invalid_input", `Conector "${connector}": ${text}`, {
          cause: error,
        });
      }
      const flow: Flow = {
        id: randomUUID(),
        connector,
        pending,
        expiresAt: now() + ttl,
        status: "pending",
        error: null,
      };
      flows.set(flow.id, flow);
      byState.set(pending.state, flow.id);
      return {
        authorizationUrl: pending.authorizationUrl.href,
        flowId: flow.id,
        redirectUri,
        expiresAt: new Date(flow.expiresAt),
      };
    },
    oauthStatus: statusOf,
    redirect: publicRedirect === undefined ? "loopback" : "public",
    async publicCallback(params) {
      if (publicRedirect === undefined) return undefined;
      return callback(params, publicRedirect);
    },
    async oauthDisconnect(connector) {
      await oauthConfigOf(connector);
      for (const flow of flows.values()) {
        if (flow.connector === connector && flow.status === "pending") {
          byState.delete(flow.pending.state);
          flows.delete(flow.id);
        }
      }
      await revokeOAuth({ store: vaultOAuthStore(db, vault, connector), fetch: deps.fetch }).catch(
        () => false,
      );
      await forgetOAuth(db, vault, connector);
      return service.update(connector, { enabled: false });
    },
    async close() {
      flows.clear();
      byState.clear();
      const open = listener;
      listener = undefined;
      if (open !== undefined) {
        await new Promise<void>((resolve) => {
          open.server.closeAllConnections();
          open.server.close(() => resolve());
        });
      }
    },
  };
  return gallery;
}
