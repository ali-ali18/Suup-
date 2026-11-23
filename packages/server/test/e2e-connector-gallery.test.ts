import { type FakeOAuthServer, startFakeOAuthMcp } from "@suup/connectors/testing";
import { generateKeyText, oauthSecretNames } from "@suup/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, useWorld } from "./world.js";

// The gallery and the OAuth login of the MCP through the API, with the real client: the app starts
// the login, "the browser" (fetch) follows the authorization server to the server's loopback
// callback, and the status turns connected. A worker in ANOTHER runtime then uses the tools with
// the tokens from the vault. No response, event or row holds a token.

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("connector gallery and OAuth through the API"),
  { timeout: 90_000 },
  () => {
    const w = useWorld({
      scripts: { roteiro: { agent: [] } },
      config: { approvals: {}, vault: { keyEnv: "SERVER_TEST_VAULT_KEY" } },
      env: { SERVER_TEST_VAULT_KEY: generateKeyText() },
    });
    let fake: FakeOAuthServer | undefined;
    afterAll(async () => {
      await fake?.close();
    });
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "no error",
        (error: { code?: string }) => error.code ?? String(error),
      );

    it("lists the gallery, installs entries, and refuses what cannot be installed", async () => {
      const { api } = w.started;
      const items = await api.connectorCatalog.list();
      expect(items.map((i) => i.entry.id)).toEqual([
        "github",
        "notion",
        "linear",
        "figma",
        "stackoverflow",
        "google-workspace",
        "composio",
      ]);
      const composio = items.find((i) => i.entry.id === "composio");
      expect(composio).toMatchObject({
        status: "available",
        entry: {
          icon: null,
          auth: { kind: "token", secret: "COMPOSIO_API_KEY", header: "x-consumer-api-key" },
        },
      });
      expect(composio?.entry.disclosure).toContain("Composio");
      expect(items.find((i) => i.entry.id === "github")?.entry.icon).toBe("github");
      expect(items.find((i) => i.entry.id === "google-workspace")).toMatchObject({
        status: "unverified",
        entry: { auth: { kind: "oauth_owner_client" }, transport: null },
      });

      const notion = await api.connectorCatalog.install("notion");
      expect(notion).toMatchObject({
        next: "login",
        item: { status: "needs_login", connector: "notion" },
        connector: {
          enabled: false,
          catalogId: "notion",
          oauth: { status: "needs_login", lastError: null, expiresAt: null },
          transport: { kind: "http", url: "https://mcp.notion.com/mcp", oauth: {} },
        },
      });
      expect(await code(api.connectorCatalog.install("stackoverflow"))).toBe("conflict");
      expect(await code(api.connectorCatalog.install("nada-disso"))).toBe("not_found");

      // A token entry: installed off; the token through the vault (the secure form); then on.
      const github = await api.connectorCatalog.install("github");
      expect(github).toMatchObject({ next: "secret", item: { status: "needs_secret" } });
      await api.vault.set("GITHUB_TOKEN", { value: "ghp_made_up_for_the_api_test_42" });
      const again = await api.connectorCatalog.install("github");
      expect(again).toMatchObject({ next: "none", item: { status: "connected" } });
      expect(again.connector.enabled).toBe(true);
      // A token connector has no OAuth to start.
      expect(await code(api.connectors.oauthStart("github"))).toBe("invalid_request");
      await api.connectors.remove("github");
      await api.connectors.remove("notion");
    });

    it("logs in with OAuth: start, browser, loopback callback, connected; a worker uses the tools; disconnect", async () => {
      const { api } = w.started;
      fake = await startFakeOAuthMcp();
      await api.connectors.create({
        name: "oauthfake",
        transport: { kind: "http", url: fake.mcpUrl, oauth: {} },
        enabled: false,
      });
      expect(await api.connectors.oauthStatus("oauthfake")).toMatchObject({
        status: "needs_login",
      });
      const start = await api.connectors.oauthStart("oauthfake");
      expect(await api.connectors.oauthStatus("oauthfake")).toMatchObject({
        status: "pending",
        flowId: start.flowId,
      });
      const res = await fetch(start.authorizationUrl, { redirect: "manual" });
      const back = res.headers.get("location") ?? "";
      expect(back.startsWith(start.redirectUri)).toBe(true);
      const page = await fetch(back);
      expect(page.status).toBe(200);
      const status = await api.connectors.oauthStatus("oauthfake");
      expect(status).toMatchObject({ status: "connected", error: null });
      const connector = await api.connectors.get("oauthfake");
      expect(connector.enabled).toBe(true);
      expect(connector.oauth?.status).toBe("connected");

      // The worker's runtime is another process: it reads the tokens from the vault.
      const listed = await w.workerRuntime.connectors.test("oauthfake");
      expect(listed.ok).toBe(true);
      const [access] = fake.validAccessTokens();
      expect(fake.mcpAuthorizations).toContain(`Bearer ${access}`);

      // Nothing the API answers holds a token; the vault lists them by name only.
      const bodies = JSON.stringify([
        await api.connectors.list(),
        await api.connectorCatalog.list(),
        await api.connectors.oauthStatus("oauthfake"),
        await api.vault.list(),
      ]);
      expect(bodies).not.toContain(access as string);
      for (const refresh of fake.validRefreshTokens()) expect(bodies).not.toContain(refresh);
      expect(bodies).toContain(oauthSecretNames("oauthfake").access);

      const off = await api.connectors.oauthDisconnect("oauthfake");
      expect(off.enabled).toBe(false);
      expect(fake.revocations.length).toBeGreaterThan(0);
      expect(await api.connectors.oauthStatus("oauthfake")).toMatchObject({
        status: "needs_login",
      });
      expect((await api.vault.list()).map((s) => s.name)).not.toContain(
        oauthSecretNames("oauthfake").access,
      );
    });

    it("the VPS path: the app posts the address the browser landed on", async () => {
      const { api } = w.started;
      fake ??= await startFakeOAuthMcp();
      await api.connectors.create({
        name: "oauthvps",
        transport: { kind: "http", url: fake.mcpUrl, oauth: {} },
        enabled: false,
      });
      const start = await api.connectors.oauthStart("oauthvps");
      const back =
        (await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location") ?? "";
      expect(
        await code(
          api.connectors.oauthComplete("oauthvps", {
            flowId: start.flowId,
            callbackUrl: "não é url",
          }),
        ),
      ).toBe("invalid_request");
      const done = await api.connectors.oauthComplete("oauthvps", {
        flowId: start.flowId,
        callbackUrl: back,
      });
      expect(done.status).toBe("connected");
      expect((await api.connectors.get("oauthvps")).enabled).toBe(true);
      // Used once: the same address again is refused.
      expect(
        await code(
          api.connectors.oauthComplete("oauthvps", { flowId: start.flowId, callbackUrl: back }),
        ),
      ).not.toBe("no error");
    });
  },
);
