// A fake MCP server protected by a fake OAuth authorization server, for tests (and only for tests).
// Two local HTTP servers: the RESOURCE (the MCP endpoint, which answers 401 with the
// `resource_metadata` pointer without a valid access token, and serves its protected resource
// metadata, RFC 9728) and the AUTHORIZATION SERVER (metadata RFC 8414, dynamic registration,
// `/authorize` that approves at once and redirects back with `code`, `state` and `iss`, `/token`
// that checks the PKCE S256 verifier, the redirect URI and the `resource`, refresh with rotation,
// and revocation). Every request is recorded so tests can check what the client sent. The tokens
// are random, made up here.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFakeServer } from "./fake-server.js";

export interface FakeOAuthOptions {
  /** `code_challenge_methods_supported`; `null` leaves it out (no PKCE). Default `["S256"]`. */
  pkceMethods?: string[] | null;
  /** Offer dynamic client registration. Default true. */
  registration?: boolean;
  /** Advertise `authorization_response_iss_parameter_supported`. Default true. */
  advertiseIss?: boolean;
  /** The `iss` the redirect carries: default the real issuer; `null` leaves it out. */
  issInRedirect?: string | null;
  /** Serve the protected resource metadata. Default true. */
  resourceMetadata?: boolean;
  /** The token endpoint, as advertised (to test an insecure one). */
  tokenEndpointOverride?: string;
}

export interface FakeOAuthServer {
  /** The MCP endpoint (the protected resource). */
  mcpUrl: string;
  /** The authorization server's issuer. */
  issuer: string;
  registrations: Record<string, unknown>[];
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  revocations: URLSearchParams[];
  /** The `Authorization` header of each MCP request. */
  mcpAuthorizations: (string | undefined)[];
  /** What the write tools received. */
  calls: string[];
  /** Makes every access token handed out so far invalid (the next MCP request gets 401). */
  expireAccessTokens(): void;
  /** The access tokens currently valid. */
  validAccessTokens(): string[];
  close(): Promise<void>;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");
const token = (prefix: string): string => `${prefix}${b64url(randomBytes(24))}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const json = (res: ServerResponse, status: number, body: unknown, headers = {}): void => {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startFakeOAuthMcp(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
  const registrations: Record<string, unknown>[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const revocations: URLSearchParams[] = [];
  const mcpAuthorizations: (string | undefined)[] = [];
  const calls: string[] = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string | null }
  >();
  const access = new Set<string>();
  const refresh = new Map<string, { clientId: string; resource: string | null }>();

  const resourceServer = createServer();
  const asServer = createServer();
  const resourceBase = await listen(resourceServer);
  const issuer = await listen(asServer);
  const mcpUrl = `${resourceBase}/mcp`;
  const prmUrl = `${resourceBase}/.well-known/oauth-protected-resource/mcp`;

  resourceServer.on("request", (req, res) => {
    const path = new URL(req.url ?? "/", resourceBase).pathname;
    if (
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/.well-known/oauth-protected-resource"
    ) {
      if (options.resourceMetadata === false) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, {
        resource: mcpUrl,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    if (path !== "/mcp") {
      json(res, 404, { error: "not_found" });
      return;
    }
    const authorization = req.headers.authorization;
    mcpAuthorizations.push(authorization);
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (bearer === undefined || !access.has(bearer)) {
      json(
        res,
        401,
        { error: "invalid_token" },
        {
          "www-authenticate": `Bearer resource_metadata="${prmUrl}"`,
        },
      );
      return;
    }
    void (async () => {
      const raw = await readBody(req);
      const server = createFakeServer({ log: (l) => calls.push(l) }, authorization);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw === "" ? undefined : JSON.parse(raw));
    })();
  });

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: options.tokenEndpointOverride ?? `${issuer}/token`,
    ...(options.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    ...(options.pkceMethods === null
      ? {}
      : { code_challenge_methods_supported: options.pkceMethods ?? ["S256"] }),
    ...(options.advertiseIss === false
      ? {}
      : { authorization_response_iss_parameter_supported: true }),
  });

  asServer.on("request", (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      const path = url.pathname;
      if (
        req.method === "GET" &&
        (path === "/.well-known/oauth-authorization-server" ||
          path === "/.well-known/openid-configuration")
      ) {
        json(res, 200, metadata());
        return;
      }
      if (req.method === "POST" && path === "/register" && options.registration !== false) {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        registrations.push(body);
        const clientId = token("client-");
        const redirectUris = Array.isArray(body.redirect_uris)
          ? body.redirect_uris.map(String)
          : [];
        clients.set(clientId, { redirectUris });
        json(res, 201, {
          ...body,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
        return;
      }
      if (req.method === "GET" && path === "/authorize") {
        const p = url.searchParams;
        authorizeRequests.push(p);
        const client = clients.get(p.get("client_id") ?? "");
        const redirectUri = p.get("redirect_uri") ?? "";
        if (client === undefined || !client.redirectUris.includes(redirectUri)) {
          res.writeHead(400).end("unknown client or redirect_uri");
          return;
        }
        if (p.get("code_challenge_method") !== "S256" || p.get("code_challenge") === null) {
          res.writeHead(400).end("PKCE S256 required");
          return;
        }
        const code = token("code-");
        codes.set(code, {
          clientId: p.get("client_id") ?? "",
          redirectUri,
          challenge: p.get("code_challenge") ?? "",
          resource: p.get("resource"),
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        const state = p.get("state");
        if (state !== null) back.searchParams.set("state", state);
        const iss = options.issInRedirect === undefined ? issuer : options.issInRedirect;
        if (iss !== null) back.searchParams.set("iss", iss);
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (req.method === "POST" && path === "/token") {
        const p = new URLSearchParams(await readBody(req));
        tokenRequests.push(p);
        const grant = p.get("grant_type");
        if (grant === "authorization_code") {
          const entry = codes.get(p.get("code") ?? "");
          codes.delete(p.get("code") ?? "");
          const verifier = p.get("code_verifier") ?? "";
          const challenge = b64url(createHash("sha256").update(verifier).digest());
          if (
            entry === undefined ||
            entry.clientId !== p.get("client_id") ||
            entry.redirectUri !== p.get("redirect_uri") ||
            entry.challenge !== challenge ||
            entry.resource !== p.get("resource")
          ) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          const at = token("fake-at-");
          const rt = token("fake-rt-");
          access.add(at);
          refresh.set(rt, { clientId: entry.clientId, resource: entry.resource });
          json(res, 200, {
            access_token: at,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: rt,
            scope: "read",
          });
          return;
        }
        if (grant === "refresh_token") {
          const rt = p.get("refresh_token") ?? "";
          const entry = refresh.get(rt);
          if (entry === undefined || entry.resource !== p.get("resource")) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          refresh.delete(rt);
          const at = token("fake-at-");
          const next = token("fake-rt-");
          access.add(at);
          refresh.set(next, entry);
          json(res, 200, {
            access_token: at,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: next,
          });
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (req.method === "POST" && path === "/revoke") {
        const p = new URLSearchParams(await readBody(req));
        revocations.push(p);
        const t = p.get("token") ?? "";
        access.delete(t);
        refresh.delete(t);
        res.writeHead(200).end();
        return;
      }
      json(res, 404, { error: "not_found" });
    })();
  });

  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return {
    mcpUrl,
    issuer,
    registrations,
    authorizeRequests,
    tokenRequests,
    revocations,
    mcpAuthorizations,
    calls,
    expireAccessTokens: () => access.clear(),
    validAccessTokens: () => [...access],
    close: async () => {
      await Promise.all([close(resourceServer), close(asServer)]);
    },
  };
}
