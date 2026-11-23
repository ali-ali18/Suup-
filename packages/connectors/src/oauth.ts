// Owns the OAuth of the MCP protocol on the client side, for a desktop or server that is not a web
// page: discovering who authorizes the server (RFC 9728, then RFC 8414 / OpenID discovery),
// refusing an authorization server without PKCE S256 or with an insecure endpoint, registering the
// client (pre-registered -> Client ID Metadata Document -> Dynamic Client Registration -> ask the
// person), the browser step with a random single-use `state`, the issuer check of RFC 9207 (`iss`)
// on the way back, the code exchange with the PKCE verifier and the `resource` indicator (RFC 8707),
// refresh, and revocation. The protocol steps are the official SDK's (`auth()`); this file adds what
// the specification 2026-07-28 asks and the SDK 1.x does not do (PKCE refusal, `iss`, endpoint
// checks), and keeps everything behind a store the caller provides (the vault, in the Suup).
//
// Where the tokens live, where the callback listens and when a connector is enabled are the
// runtime's business. Research: docs/pesquisas/fase-4-conectores-galeria-oauth-composio.md.
import { randomBytes } from "node:crypto";
import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** What is kept of one connector's OAuth between logins. Secret parts are the store's to protect. */
export interface StoredOAuth {
  /** The client as registered (or pre-registered), bound to the authorization server (`issuer`). */
  client?: OAuthClientInformationMixed | undefined;
  /** The tokens, bound to the authorization server (`issuer`), and when they were received. */
  tokens?: (OAuthTokens & { obtainedAt?: number | undefined }) | undefined;
  /** What discovery found: the protected resource and its authorization server. */
  discovery?: OAuthDiscoveryState | undefined;
  /** The redirect URI of the last login (a registered client is bound to it). */
  redirectUri?: string | undefined;
}

/**
 * Where a connector's OAuth state is kept. `read` returns everything; `write` replaces it. The Suup's
 * store puts the access token, the refresh token and the client secret in the vault (encrypted) and
 * the rest (public metadata, expiry) in the database.
 */
export interface OAuthStore {
  read(): Promise<StoredOAuth>;
  write(next: StoredOAuth): Promise<void>;
  /** The tokens cannot be used or renewed any more: a person must log in again. */
  loginRequired?(reason: string): Promise<void>;
}

export type OAuthFlowErrorCode =
  | "no_resource_metadata"
  | "no_authorization_server"
  | "no_pkce"
  | "insecure_endpoint"
  | "issuer_mismatch"
  | "no_registration"
  | "state_invalid"
  | "iss_missing"
  | "iss_mismatch"
  | "denied"
  | "no_code"
  | "exchange_failed";

/** A login that cannot go on, with a message for the person (pt-BR). */
export class OAuthFlowError extends Error {
  override readonly name = "OAuthFlowError";
  constructor(
    readonly code: OAuthFlowErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** The connector has no usable tokens: someone must log in (in the app). */
export class OAuthLoginRequiredError extends Error {
  override readonly name = "OAuthLoginRequiredError";
}

/** An OAuth client the person registered on the service (pre-registration). */
export interface PreRegisteredClient {
  clientId: string;
  clientSecret?: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** HTTPS, or plain HTTP only to this computer (a local test server). */
export function isSecureEndpoint(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

/** The same authorization server: URLs compared as parsed, tolerating one trailing slash. */
function sameServer(a: string, b: string): boolean {
  let x = a;
  let y = b;
  try {
    x = new URL(a).href;
    y = new URL(b).href;
  } catch {
    // compared as written
  }
  return (
    x === y ||
    (x.endsWith("/") && x.slice(0, -1) === y) ||
    (y.endsWith("/") && y.slice(0, -1) === x)
  );
}

/** The metadata a client sends when it registers itself (DCR) and that a CIMD document describes. */
export function clientMetadataFor(clientName: string, redirectUri: string): OAuthClientMetadata {
  return {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    // The specification: native applications (desktop apps, local servers) say so.
    application_type: "native",
  } as OAuthClientMetadata;
}

interface ProviderOptions {
  store: OAuthStore;
  clientName: string;
  redirectUri: string;
  preRegistered?: PreRegisteredClient | undefined;
  clientMetadataUrl?: string | undefined;
  /** A login in progress: the browser step is allowed, with this `state`. */
  interactive?: { state: string; onRedirect(url: URL): void } | undefined;
  now: () => number;
}

/** The SDK's view of one connector's OAuth: every read and write goes to the store. */
class StoreProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  readonly clientMetadataUrl?: string;

  constructor(private readonly o: ProviderOptions) {
    if (o.clientMetadataUrl !== undefined) this.clientMetadataUrl = o.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.o.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(this.o.clientName, this.o.redirectUri);
  }

  state(): string {
    if (this.o.interactive === undefined) throw new OAuthLoginRequiredError("login necessário");
    return this.o.interactive.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.o.preRegistered !== undefined) {
      const stored = (await this.o.store.read()).client;
      return {
        client_id: this.o.preRegistered.clientId,
        ...(this.o.preRegistered.clientSecret === undefined
          ? {}
          : { client_secret: this.o.preRegistered.clientSecret }),
        // Keeps the binding to the authorization server once it was made.
        ...(stored?.client_id === this.o.preRegistered.clientId && stored.issuer !== undefined
          ? { issuer: stored.issuer }
          : {}),
      };
    }
    const client = (await this.o.store.read()).client;
    if (client === undefined) return undefined;
    // A client registered for another redirect URI (another port) cannot come back here: in a
    // login, register again. Exact comparison of the URI.
    if (
      this.o.interactive !== undefined &&
      "redirect_uris" in client &&
      Array.isArray(client.redirect_uris) &&
      !client.redirect_uris.map(String).includes(this.o.redirectUri)
    ) {
      return undefined;
    }
    return client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const current = await this.o.store.read();
    // Outside a login, the client may only be bound (stamped), never registered anew.
    if (this.o.interactive === undefined && current.client?.client_id !== info.client_id) {
      throw new OAuthLoginRequiredError("o cliente OAuth precisa ser registrado num login");
    }
    await this.o.store.write({ ...current, client: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = (await this.o.store.read()).tokens;
    if (tokens === undefined) return undefined;
    const { obtainedAt: _at, ...rest } = tokens;
    return rest;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const current = await this.o.store.read();
    await this.o.store.write({
      ...current,
      tokens: { ...tokens, obtainedAt: this.o.now() },
      redirectUri: current.redirectUri ?? this.o.redirectUri,
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.o.interactive === undefined) {
      await this.o.store.loginRequired?.("o login expirou ou foi recusado");
      throw new OAuthLoginRequiredError("é preciso fazer login de novo (OAuth)");
    }
    this.o.interactive.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    // Only in memory, only for this login: never stored.
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined)
      throw new OAuthFlowError("state_invalid", "login sem verificador PKCE");
    return this.verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const current = await this.o.store.read();
    await this.o.store.write({ ...current, discovery: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.o.store.read()).discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    if (this.o.interactive === undefined) {
      // A connection does not throw away what a login saved: it says a login is needed.
      await this.o.store.loginRequired?.("o servidor de autorização recusou as credenciais");
      throw new OAuthLoginRequiredError("é preciso fazer login de novo (OAuth)");
    }
    const current = await this.o.store.read();
    const next: StoredOAuth = { ...current };
    if (scope === "all" || scope === "client") delete next.client;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    await this.o.store.write(next);
  }
}

/**
 * The provider a CONNECTION uses (no browser): it sends the stored access token, renews it with the
 * refresh token when the server answers 401, and stops with `OAuthLoginRequiredError` when only a
 * new login would help. It never registers a client nor opens a browser.
 */
export async function connectionOAuthProvider(options: {
  store: OAuthStore;
  clientName: string;
  preRegistered?: PreRegisteredClient | undefined;
  now?: (() => number) | undefined;
}): Promise<OAuthClientProvider> {
  const stored = await options.store.read();
  if (stored.tokens === undefined) {
    throw new OAuthLoginRequiredError("o conector ainda não tem login (OAuth)");
  }
  return new StoreProvider({
    store: options.store,
    clientName: options.clientName,
    // The URI of the login: a token request with a refresh token does not send it, but the SDK
    // needs one to know this is not a machine-to-machine client.
    redirectUri: stored.redirectUri ?? "http://127.0.0.1/callback",
    preRegistered: options.preRegistered,
    now: options.now ?? Date.now,
  });
}

/** A login waiting for the browser to come back. Keep it in memory only. */
export interface PendingLogin {
  /** Open this in the person's browser. */
  authorizationUrl: URL;
  /** Random, single use: the callback must bring it back. */
  state: string;
  /** The authorization server's `issuer`, recorded before the redirect (RFC 9207). */
  issuer: string;
  /** The server promised to send `iss` in its answer: then its absence is refused. */
  issRequired: boolean;
  redirectUri: string;
  /** For `completeOAuthLogin` only. */
  readonly internal: {
    provider: OAuthClientProvider;
    serverUrl: string;
    fetch: typeof fetch | undefined;
  };
}

export interface BeginLoginOptions {
  /** The MCP server (the protected resource). */
  serverUrl: string;
  store: OAuthStore;
  /** Where the browser comes back: `http://127.0.0.1:<port>/callback`. */
  redirectUri: string;
  /** The name the client presents: always its true name. */
  clientName: string;
  scopes?: readonly string[] | undefined;
  preRegistered?: PreRegisteredClient | undefined;
  /** An HTTPS URL of this client's metadata document (CIMD), when there is one. */
  clientMetadataUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

/**
 * Starts a login: discovery, the checks of the specification, the client registration, and the
 * authorization URL (with PKCE S256, `state` and `resource`). The tokens stored before are dropped
 * (this is a new login); the client registration is kept when it still fits.
 */
export async function beginOAuthLogin(options: BeginLoginOptions): Promise<PendingLogin> {
  const fetchFn = options.fetch;
  let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      options.serverUrl,
      undefined,
      fetchFn,
    );
  } catch (error) {
    throw new OAuthFlowError(
      "no_resource_metadata",
      "o servidor não publica os metadados de recurso protegido (RFC 9728) que o MCP exige para o login",
      error,
    );
  }
  const authorizationServer = resourceMetadata.authorization_servers?.[0];
  if (authorizationServer === undefined) {
    throw new OAuthFlowError(
      "no_authorization_server",
      "os metadados do servidor não dizem quem autoriza o login (authorization_servers)",
    );
  }
  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServer, {
      ...(fetchFn === undefined ? {} : { fetchFn }),
    });
  } catch (error) {
    throw new OAuthFlowError(
      "no_authorization_server",
      `não foi possível ler os metadados do servidor de autorização ${authorizationServer}`,
      error,
    );
  }
  if (metadata === undefined) {
    throw new OAuthFlowError(
      "no_authorization_server",
      `o servidor de autorização ${authorizationServer} não publica os seus metadados`,
    );
  }
  if (!sameServer(metadata.issuer, authorizationServer)) {
    throw new OAuthFlowError(
      "issuer_mismatch",
      `os metadados de ${authorizationServer} dizem ser de outro emissor (${metadata.issuer})`,
    );
  }
  // The specification: no `code_challenge_methods_supported` means no PKCE, and the client MUST
  // refuse; S256 MUST be used.
  if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new OAuthFlowError(
      "no_pkce",
      "o servidor de autorização não declara PKCE com S256: o login foi recusado por segurança",
    );
  }
  const endpoints: [string, string | undefined][] = [
    ["autorização", metadata.authorization_endpoint],
    ["token", metadata.token_endpoint],
    ...("registration_endpoint" in metadata && metadata.registration_endpoint !== undefined
      ? ([["registro", metadata.registration_endpoint]] as [string, string][])
      : []),
  ];
  for (const [what, url] of endpoints) {
    if (!isSecureEndpoint(url)) {
      throw new OAuthFlowError(
        "insecure_endpoint",
        `o endereço de ${what} do servidor de autorização não usa HTTPS`,
      );
    }
  }
  const cimd =
    (metadata as { client_id_metadata_document_supported?: unknown })
      .client_id_metadata_document_supported === true && options.clientMetadataUrl !== undefined;
  const stored = await options.store.read();
  const now = options.now ?? Date.now;
  // A new login: the old tokens go; discovery is the one just made.
  await options.store.write({
    ...(stored.client === undefined ? {} : { client: stored.client }),
    discovery: {
      authorizationServerUrl: authorizationServer,
      resourceMetadata,
      authorizationServerMetadata: metadata,
    },
    redirectUri: options.redirectUri,
  });

  const state = randomBytes(32).toString("base64url");
  let authorizationUrl: URL | undefined;
  const provider = new StoreProvider({
    store: options.store,
    clientName: options.clientName,
    redirectUri: options.redirectUri,
    preRegistered: options.preRegistered,
    clientMetadataUrl: options.clientMetadataUrl,
    interactive: {
      state,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    },
    now,
  });
  const hasClient = (await provider.clientInformation()) !== undefined;
  const canRegister =
    "registration_endpoint" in metadata && metadata.registration_endpoint !== undefined;
  if (!hasClient && !cimd && !canRegister) {
    throw new OAuthFlowError(
      "no_registration",
      "o servidor não aceita que um aplicativo se registre sozinho: registre um app OAuth no serviço e informe o ID do cliente no conector (oauth.clientId), ou use um token",
    );
  }
  try {
    await auth(provider, {
      serverUrl: options.serverUrl,
      ...(options.scopes === undefined || options.scopes.length === 0
        ? {}
        : { scope: options.scopes.join(" ") }),
      ...(fetchFn === undefined ? {} : { fetchFn }),
    });
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error;
    throw new OAuthFlowError(
      hasClient ? "exchange_failed" : "no_registration",
      `o servidor de autorização recusou ${hasClient ? "o início do login" : "o registro do aplicativo"} (${errorText(error)})`,
      error,
    );
  }
  if (authorizationUrl === undefined) {
    throw new OAuthFlowError("exchange_failed", "o login não produziu um endereço de autorização");
  }
  return {
    authorizationUrl,
    state,
    issuer: metadata.issuer,
    issRequired:
      (metadata as { authorization_response_iss_parameter_supported?: unknown })
        .authorization_response_iss_parameter_supported === true,
    redirectUri: options.redirectUri,
    internal: { provider, serverUrl: options.serverUrl, fetch: fetchFn },
  };
}

/**
 * Finishes a login with the parameters the browser brought back to the redirect URI. The caller
 * already matched `state` to this login (and used it up). Checks `error`, `iss` (RFC 9207), then
 * exchanges the code (PKCE verifier, `resource`) and stores the tokens.
 */
export async function completeOAuthLogin(
  login: PendingLogin,
  params: URLSearchParams,
): Promise<void> {
  if (params.get("state") !== login.state) {
    throw new OAuthFlowError("state_invalid", "o retorno do login não corresponde a este login");
  }
  const error = params.get("error");
  if (error !== null) {
    const description = params.get("error_description");
    throw new OAuthFlowError(
      "denied",
      `o login foi recusado (${error}${description === null ? "" : `: ${description.slice(0, 200)}`})`,
    );
  }
  const iss = params.get("iss");
  if (iss === null && login.issRequired) {
    throw new OAuthFlowError("iss_missing", "o retorno do login não diz quem o emitiu (iss)");
  }
  // RFC 9207: a simple string comparison with the issuer recorded before the redirect.
  if (iss !== null && iss !== login.issuer) {
    throw new OAuthFlowError(
      "iss_mismatch",
      "o retorno do login veio de outro servidor de autorização: recusado",
    );
  }
  const code = params.get("code");
  if (code === null || code === "") {
    throw new OAuthFlowError("no_code", "o retorno do login não trouxe o código de autorização");
  }
  try {
    const result = await auth(login.internal.provider, {
      serverUrl: login.internal.serverUrl,
      authorizationCode: code,
      ...(login.internal.fetch === undefined ? {} : { fetchFn: login.internal.fetch }),
    });
    if (result !== "AUTHORIZED") {
      throw new OAuthFlowError("exchange_failed", "o servidor não entregou os tokens");
    }
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error;
    throw new OAuthFlowError(
      "exchange_failed",
      `a troca do código pelo token falhou (${errorText(error)})`,
      error,
    );
  }
}

/**
 * Asks the authorization server to revoke the stored tokens (RFC 7009), when it has a revocation
 * endpoint. Best effort: the caller removes the tokens anyway. Returns whether a request was made.
 */
export async function revokeOAuth(options: {
  store: OAuthStore;
  fetch?: typeof fetch | undefined;
  preRegistered?: PreRegisteredClient | undefined;
}): Promise<boolean> {
  const stored = await options.store.read();
  const endpoint = (
    stored.discovery?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined
  )?.revocation_endpoint;
  if (typeof endpoint !== "string" || !isSecureEndpoint(endpoint)) return false;
  const clientId = options.preRegistered?.clientId ?? stored.client?.client_id;
  const clientSecret = options.preRegistered?.clientSecret ?? stored.client?.client_secret;
  const tokens = [
    ...(stored.tokens?.refresh_token === undefined
      ? []
      : [[stored.tokens.refresh_token, "refresh_token"] as const]),
    ...(stored.tokens?.access_token === undefined
      ? []
      : [[stored.tokens.access_token, "access_token"] as const]),
  ];
  const doFetch = options.fetch ?? fetch;
  let sent = false;
  for (const [token, hint] of tokens) {
    const body = new URLSearchParams({ token, token_type_hint: hint });
    if (clientId !== undefined) body.set("client_id", clientId);
    if (clientSecret !== undefined) body.set("client_secret", clientSecret);
    try {
      await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      sent = true;
    } catch {
      // the tokens are removed here anyway
    }
  }
  return sent;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
