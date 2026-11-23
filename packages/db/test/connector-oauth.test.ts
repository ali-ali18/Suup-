import { describe, expect, it } from "vitest";
import {
  createConnector,
  deleteConnector,
  deleteConnectorOAuth,
  getConnector,
  getConnectorOAuth,
  saveConnectorOAuth,
  setConnectorOAuthStatus,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const http = (name: string) => ({
  name,
  description: "",
  transport: "http" as const,
  command: null,
  args: [],
  cwd: null,
  env: {},
  url: "https://mcp.example.com/mcp",
  headers: {},
  scope: "read_write" as const,
  toolOverrides: {},
  trustAnnotations: false,
  timeoutMs: null,
  enabled: false,
  origin: "user" as const,
  oauth: { scopes: ["read"] },
  catalogId: "notion",
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("connector OAuth rows"), () => {
  const ctx = useIsolatedDb();

  it("keeps the OAuth configuration and the gallery entry of a connector", async () => {
    const created = await createConnector(ctx.db, http("notion"));
    expect(created.oauth).toEqual({ scopes: ["read"] });
    expect(created.catalogId).toBe("notion");
  });

  it("stores the public part of a login, its state, and goes with the connector", async () => {
    await createConnector(ctx.db, http("lin"));
    expect(await getConnectorOAuth(ctx.db, "lin")).toBeNull();
    await saveConnectorOAuth(ctx.db, "lin", {
      status: "connected",
      discovery: { authorizationServerUrl: "https://auth.example.com" },
      client: { client_id: "abc", issuer: "https://auth.example.com" },
      tokenInfo: { expires_in: 3600 },
      redirectUri: "http://127.0.0.1:5000/callback",
      lastError: null,
    });
    expect(await getConnectorOAuth(ctx.db, "lin")).toMatchObject({
      status: "connected",
      client: { client_id: "abc" },
      redirectUri: "http://127.0.0.1:5000/callback",
    });
    await setConnectorOAuthStatus(ctx.db, "lin", "needs_login", "expirou");
    expect(await getConnectorOAuth(ctx.db, "lin")).toMatchObject({
      status: "needs_login",
      lastError: "expirou",
      client: { client_id: "abc" },
    });
    await deleteConnectorOAuth(ctx.db, "lin");
    expect(await getConnectorOAuth(ctx.db, "lin")).toBeNull();
    await setConnectorOAuthStatus(ctx.db, "lin", "error", "x");
    await deleteConnector(ctx.db, "lin");
    expect(await getConnector(ctx.db, "lin")).toBeNull();
    const [count] = await ctx.db.sql<
      { n: number }[]
    >`select count(*)::int as n from connector_oauth`;
    expect(count?.n).toBe(0);
  });
});
