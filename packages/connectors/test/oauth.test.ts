import { afterEach, describe, expect, it } from "vitest";
import {
  beginOAuthLogin,
  ConnectorManager,
  completeOAuthLogin,
  connectionOAuthProvider,
  OAuthFlowError,
  OAuthLoginRequiredError,
  type OAuthStore,
  parseConnectorSpec,
  revokeOAuth,
  type StoredOAuth,
} from "../src/index.js";
import {
  type FakeOAuthOptions,
  type FakeOAuthServer,
  startFakeOAuthMcp,
} from "../src/testing/index.js";

const REDIRECT = "http://127.0.0.1:53682/callback";

function memoryStore(): OAuthStore & { value: StoredOAuth; required: string[] } {
  const store = {
    value: {} as StoredOAuth,
    required: [] as string[],
    async read() {
      return structuredClone(store.value);
    },
    async write(next: StoredOAuth) {
      store.value = structuredClone(next);
    },
    async loginRequired(reason: string) {
      store.required.push(reason);
    },
  };
  return store;
}

let fake: FakeOAuthServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(options: FakeOAuthOptions = {}) {
  fake = await startFakeOAuthMcp(options);
  return fake;
}

/** What the browser does: open the authorization URL and come back with the redirect's parameters. */
async function browse(url: URL): Promise<URLSearchParams> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const back = new URL(location);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return back.searchParams;
}

async function login(server: FakeOAuthServer, store = memoryStore()) {
  const pending = await beginOAuthLogin({
    serverUrl: server.mcpUrl,
    store,
    redirectUri: REDIRECT,
    clientName: "Suup",
  });
  const params = await browse(pending.authorizationUrl);
  await completeOAuthLogin(pending, params);
  return { store, pending, params };
}

const flowError = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthFlowError);
    return (error as OAuthFlowError).code;
  }
  throw new Error("expected a refusal");
};

describe("MCP OAuth login", () => {
  it("discovers, registers as a native client, uses PKCE S256, state and resource, and stores the tokens", async () => {
    const server = await start();
    const { store, pending, params } = await login(server);
    // Registration: the true name, native, the loopback redirect.
    expect(server.registrations).toHaveLength(1);
    expect(server.registrations[0]).toMatchObject({
      client_name: "Suup",
      application_type: "native",
      redirect_uris: [REDIRECT],
    });
    // Authorization request.
    const auth = server.authorizeRequests[0] as URLSearchParams;
    expect(auth.get("code_challenge_method")).toBe("S256");
    expect(auth.get("resource")).toBe(server.mcpUrl);
    expect(auth.get("state")).toBe(pending.state);
    expect(pending.state.length).toBeGreaterThanOrEqual(40);
    expect(pending.issuer).toBe(server.issuer);
    expect(params.get("iss")).toBe(server.issuer);
    // Token request: the verifier and the resource (the fake checks the verifier against the challenge).
    const tokenRequest = server.tokenRequests[0] as URLSearchParams;
    expect(tokenRequest.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
    expect(tokenRequest.get("resource")).toBe(server.mcpUrl);
    expect(store.value.tokens?.access_token).toBe(server.validAccessTokens()[0]);
    expect(store.value.tokens?.refresh_token).toBeDefined();
    expect(store.value.redirectUri).toBe(REDIRECT);
    // The verifier is never stored.
    expect(JSON.stringify(store.value)).not.toContain(tokenRequest.get("code_verifier") ?? "x");
  });

  it("a connection uses the token and renews it on a 401", async () => {
    const server = await start();
    const { store } = await login(server);
    const manager = new ConnectorManager({
      resolveSecrets: async () => ({}),
      oauthProvider: async () => connectionOAuthProvider({ store, clientName: "Suup" }),
    });
    try {
      const spec = parseConnectorSpec({
        name: "fake",
        transport: { kind: "http", url: server.mcpUrl, oauth: {} },
      });
      const first = await manager.test(spec);
      expect(first.tools.map((t) => t.name)).toContain("echo");
      const before = store.value.tokens?.access_token;
      server.expireAccessTokens();
      const second = await manager.test(spec);
      expect(second.tools.map((t) => t.name)).toContain("echo");
      expect(server.tokenRequests.map((p) => p.get("grant_type"))).toContain("refresh_token");
      expect(store.value.tokens?.access_token).not.toBe(before);
      expect(server.validAccessTokens()).toContain(store.value.tokens?.access_token);
    } finally {
      await manager.close();
    }
  });

  it("without tokens, a connection says a login is needed and never opens a browser", async () => {
    const server = await start();
    const store = memoryStore();
    await expect(connectionOAuthProvider({ store, clientName: "Suup" })).rejects.toBeInstanceOf(
      OAuthLoginRequiredError,
    );
    const manager = new ConnectorManager({
      resolveSecrets: async () => ({}),
      oauthProvider: async () => connectionOAuthProvider({ store, clientName: "Suup" }),
    });
    try {
      const spec = parseConnectorSpec({
        name: "fake",
        transport: { kind: "http", url: server.mcpUrl, oauth: {} },
      });
      await expect(manager.test(spec)).rejects.toThrow("precisa de login");
      expect(server.authorizeRequests).toHaveLength(0);
      expect(server.registrations).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });

  it("a refresh token the server refuses marks the connector for a new login", async () => {
    const server = await start();
    const { store } = await login(server);
    // The server forgets everything this client had (revoked elsewhere).
    await revokeOAuth({ store });
    server.expireAccessTokens();
    const manager = new ConnectorManager({
      resolveSecrets: async () => ({}),
      oauthProvider: async () => connectionOAuthProvider({ store, clientName: "Suup" }),
    });
    try {
      const spec = parseConnectorSpec({
        name: "fake",
        transport: { kind: "http", url: server.mcpUrl, oauth: {} },
      });
      await expect(manager.test(spec)).rejects.toThrow();
      expect(store.required.length).toBeGreaterThan(0);
      expect(server.authorizeRequests).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  it("refuses an authorization server without PKCE S256", async () => {
    expect(
      await flowError(
        beginOAuthLogin({
          serverUrl: (await start({ pkceMethods: null })).mcpUrl,
          store: memoryStore(),
          redirectUri: REDIRECT,
          clientName: "Suup",
        }),
      ),
    ).toBe("no_pkce");
    await fake?.close();
    expect(
      await flowError(
        beginOAuthLogin({
          serverUrl: (await start({ pkceMethods: ["plain"] })).mcpUrl,
          store: memoryStore(),
          redirectUri: REDIRECT,
          clientName: "Suup",
        }),
      ),
    ).toBe("no_pkce");
  });

  it("refuses a server without protected resource metadata, an insecure token endpoint, and no way to register", async () => {
    const begin = async (options: FakeOAuthOptions) => {
      const server = await start(options);
      try {
        return await flowError(
          beginOAuthLogin({
            serverUrl: server.mcpUrl,
            store: memoryStore(),
            redirectUri: REDIRECT,
            clientName: "Suup",
          }),
        );
      } finally {
        await server.close();
        fake = undefined;
      }
    };
    expect(await begin({ resourceMetadata: false })).toBe("no_resource_metadata");
    expect(await begin({ tokenEndpointOverride: "http://auth.example.com/token" })).toBe(
      "insecure_endpoint",
    );
    expect(await begin({ registration: false })).toBe("no_registration");
  });

  it("checks iss: a different issuer and a missing one (when promised) are refused", async () => {
    const run = async (options: FakeOAuthOptions) => {
      const server = await start(options);
      try {
        const store = memoryStore();
        const pending = await beginOAuthLogin({
          serverUrl: server.mcpUrl,
          store,
          redirectUri: REDIRECT,
          clientName: "Suup",
        });
        const params = await browse(pending.authorizationUrl);
        try {
          await completeOAuthLogin(pending, params);
          return { code: "ok", tokens: store.value.tokens };
        } catch (error) {
          return { code: (error as OAuthFlowError).code, tokens: store.value.tokens };
        }
      } finally {
        await server.close();
        fake = undefined;
      }
    };
    const other = await run({ issInRedirect: "https://evil.example.com" });
    expect(other.code).toBe("iss_mismatch");
    expect(other.tokens).toBeUndefined();
    expect((await run({ issInRedirect: null })).code).toBe("iss_missing");
    // A server that never promised `iss` may leave it out.
    expect((await run({ issInRedirect: null, advertiseIss: false })).code).toBe("ok");
  });

  it("refuses a callback with another state and an authorization error", async () => {
    const server = await start();
    const pending = await beginOAuthLogin({
      serverUrl: server.mcpUrl,
      store: memoryStore(),
      redirectUri: REDIRECT,
      clientName: "Suup",
    });
    const params = await browse(pending.authorizationUrl);
    const forged = new URLSearchParams(params);
    forged.set("state", "another");
    expect(await flowError(completeOAuthLogin(pending, forged))).toBe("state_invalid");
    expect(
      await flowError(
        completeOAuthLogin(
          pending,
          new URLSearchParams({ state: pending.state, error: "access_denied" }),
        ),
      ),
    ).toBe("denied");
    expect(server.tokenRequests).toHaveLength(0);
  });

  it("revokes the tokens at the authorization server", async () => {
    const server = await start();
    const { store } = await login(server);
    const refresh = store.value.tokens?.refresh_token;
    expect(await revokeOAuth({ store })).toBe(true);
    expect(server.revocations.map((p) => p.get("token"))).toContain(refresh);
    expect(server.validAccessTokens()).toHaveLength(0);
  });

  it("a new login re-registers when the redirect port changed", async () => {
    const server = await start();
    const { store } = await login(server);
    const pending = await beginOAuthLogin({
      serverUrl: server.mcpUrl,
      store,
      redirectUri: "http://127.0.0.1:53999/callback",
      clientName: "Suup",
    });
    expect(server.registrations).toHaveLength(2);
    expect(pending.authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:53999/callback",
    );
    // The old tokens went away with the new login.
    expect(store.value.tokens).toBeUndefined();
  });
});
