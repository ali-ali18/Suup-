import { join } from "node:path";
import { type CatalogEntry, CONNECTOR_CATALOG } from "@suup/connectors";
import { type FakeOAuthServer, startFakeOAuthMcp } from "@suup/connectors/testing";
import { createBot, type Db, decideApproval, listApprovals, listRunEvents } from "@suup/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectLinkProblem,
  createConnectorService,
  createRuntime,
  generateKeyText,
  oauthSecretNames,
  PROPOSE_CONNECTOR_TOOL,
  parseConfig,
  proposeConnectorTool,
  type Runtime,
  showConnectCardTool,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

async function dump(db: Db, schema: string): Promise<string> {
  const tables = await db.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = ${schema}`;
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = await db.sql.unsafe(
      `select row_to_json(t)::text as j from "${schema}"."${table_name}" t`,
    );
    parts.push(...rows.map((r) => String(r.j)));
  }
  return parts.join("\n");
}

/** The browser: opens the authorization URL and returns where the server sends it back. */
async function authorize(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("connector gallery and MCP OAuth"),
  { timeout: 60_000 },
  () => {
    const ctx = useIsolatedDb();
    let fake: FakeOAuthServer | undefined;
    let runtime: Runtime | undefined;
    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
      await fake?.close();
      fake = undefined;
    });

    async function open(
      script: unknown = { agent: [{ text: "ok" }] },
      connectorCatalog?: readonly CatalogEntry[],
      server?: Record<string, unknown>,
    ) {
      await ctx.db.sql`delete from connectors`;
      await ctx.db.sql`delete from secrets`;
      const dir = await tempDir();
      await writeJson(join(dir, "script.json"), script);
      const env = { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() };
      runtime = createRuntime(
        parseConfig(
          rawConfig({
            vault: { keyEnv: "TEST_VAULT_KEY" },
            toolSearch: { minTools: 1000, minDefinitionTokens: 1_000_000 },
            ...(server === undefined ? {} : { server }),
          }),
        ),
        { env, baseDir: dir, ...(connectorCatalog === undefined ? {} : { connectorCatalog }) },
      );
      return runtime;
    }

    async function oauthConnector(rt: Runtime, options = {}) {
      fake = await startFakeOAuthMcp(options);
      await rt.connectors.create(
        {
          name: "fakeauth",
          transport: { kind: "http", url: fake.mcpUrl, oauth: {} },
          enabled: false,
        },
        { allowMissingSecrets: true },
      );
      return fake;
    }

    it("lists every entry with where it stands, and refuses what cannot be installed", async () => {
      const rt = await open();
      const items = await rt.connectors.gallery.list();
      expect(items.map((i) => [i.entry.id, i.status])).toEqual([
        ["github", "available"],
        ["notion", "available"],
        ["linear", "available"],
        ["figma", "available"],
        ["stackoverflow", "unverified"],
        ["google-workspace", "unverified"],
        ["composio", "available"],
        ["firecrawl", "available"],
      ]);
      expect(items.find((i) => i.entry.id === "google-workspace")?.detail).toContain("Google");
      await expect(rt.connectors.gallery.install("stackoverflow")).rejects.toThrow(
        "ainda não pode ser instalado",
      );
      await expect(rt.connectors.gallery.install("higgsfield")).rejects.toThrow("não tem");
      // A connector of the same name that did not come from the gallery is never taken over.
      await rt.connectors.create(
        { name: "notion", transport: { kind: "http", url: "https://example.com/mcp" } },
        {},
      );
      await expect(rt.connectors.gallery.install("notion")).rejects.toThrow("não veio da galeria");
    });

    it("a test can give the gallery another list (the app's e2e): only those entries, installed and logged in the same way", async () => {
      fake = await startFakeOAuthMcp();
      const notion = CONNECTOR_CATALOG.find((e) => e.id === "notion");
      if (notion === undefined) throw new Error("notion missing");
      const rt = await open(undefined, [
        {
          ...notion,
          id: "fakeauth",
          name: "Falso",
          transport: { kind: "http", url: fake.mcpUrl, headers: {} },
        },
      ]);
      expect((await rt.connectors.gallery.list()).map((i) => i.entry.id)).toEqual(["fakeauth"]);
      await expect(rt.connectors.gallery.install("notion")).rejects.toThrow("não tem");
      const installed = await rt.connectors.gallery.install("fakeauth");
      expect(installed).toMatchObject({ next: "login", item: { status: "needs_login" } });
      const start = await rt.connectors.gallery.oauthStart("fakeauth");
      const page = await fetch(await authorize(start.authorizationUrl));
      expect(page.status).toBe(200);
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "connected",
      });
      expect((await rt.connectors.gallery.list())[0]?.status).toBe("connected");
    });

    it("installs an OAuth entry off, with its exact transport, and a token entry once its token is in the vault", async () => {
      const rt = await open();
      const notion = await rt.connectors.gallery.install("notion");
      expect(notion.next).toBe("login");
      expect(notion.item.status).toBe("needs_login");
      const view = await rt.connectors.get("notion");
      expect(view).toMatchObject({
        enabled: false,
        origin: "user",
        catalogId: "notion",
        transport: { kind: "http", url: "https://mcp.notion.com/mcp", oauth: {} },
        oauth: { status: "needs_login" },
      });

      const github = await rt.connectors.gallery.install("github");
      expect(github).toMatchObject({ next: "secret", item: { status: "needs_secret" } });
      const before = await rt.connectors.get("github");
      expect(before?.enabled).toBe(false);
      expect(before?.toolOverrides.get_file_contents).toEqual({ risk: "read" });
      expect(before?.secretNames).toEqual(["GITHUB_TOKEN"]);
      await rt.vault.set("GITHUB_TOKEN", "ghp_made_up_token_for_tests_0001");
      const again = await rt.connectors.gallery.install("github");
      expect(again.next).toBe("none");
      expect(again.item.status).toBe("connected");
      expect((await rt.connectors.get("github"))?.enabled).toBe(true);
    });

    it("logs in through the loopback callback: tokens in the vault only, single-use state, then the tools", async () => {
      const rt = await open();
      const server = await oauthConnector(rt);
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "needs_login",
      });
      const start = await rt.connectors.gallery.oauthStart("fakeauth");
      expect(start.redirectUri.startsWith("http://127.0.0.1:")).toBe(true);
      expect(start.redirectUri.endsWith("/callback")).toBe(true);
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "pending",
        flowId: start.flowId,
      });
      const auth = new URL(start.authorizationUrl);
      expect(auth.searchParams.get("redirect_uri")).toBe(start.redirectUri);
      expect(auth.searchParams.get("resource")).toBe(server.mcpUrl);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");

      const back = await authorize(start.authorizationUrl);
      const page = await fetch(back);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Login feito");
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "connected",
      });
      const view = await rt.connectors.get("fakeauth");
      expect(view?.enabled).toBe(true);
      expect(view?.oauth?.status).toBe("connected");
      expect(view?.oauth?.expiresAt).not.toBeNull();

      // The same callback again: the state was used up.
      const replay = await fetch(back);
      expect(replay.status).toBe(400);
      expect(await replay.text()).toContain("não vale mais");

      // The tokens are in the vault (by name), and their values are nowhere in plain text.
      const names = oauthSecretNames("fakeauth");
      const vaultNames = (await rt.vault.list({ includeManaged: true })).map((s) => s.name);
      expect(vaultNames).toEqual(expect.arrayContaining([names.access, names.refresh]));
      // They are the connector's own: the owner's list does not show them, and no bot can get them.
      const ownerNames = (await rt.vault.list()).map((s) => s.name);
      for (const name of Object.values(names)) expect(ownerNames).not.toContain(name);
      const grantee = await createBot(rt.db, {
        name: "grantee",
        modelProvider: "script",
        modelId: "model-s",
      });
      await expect(rt.vault.grant(names.access, grantee.id)).rejects.toThrow(
        "login de um conector",
      );
      await expect(rt.vault.set(names.access, "outro-valor-qualquer")).rejects.toThrow(
        "login de um conector",
      );
      expect(await rt.vault.remove(names.access)).toBe(false);
      expect(await rt.vault.infoFor(grantee.id)).toEqual([]);
      const [access] = server.validAccessTokens();
      const [refresh] = server.validRefreshTokens();
      expect(access).toBeDefined();
      const tool = await rt.connectors.test("fakeauth");
      expect(tool.ok).toBe(true);
      expect(tool.tools.map((t) => t.tool)).toContain("echo");
      const everything = await dump(rt.db, ctx.schema);
      for (const secret of [access as string, refresh].filter((v) => v !== undefined)) {
        expect(everything.includes(secret as string)).toBe(false);
        expect(everything.includes(Buffer.from(secret as string).toString("base64"))).toBe(false);
      }
      expect(JSON.stringify(await rt.connectors.get("fakeauth"))).not.toContain(access as string);
      expect(JSON.stringify(await rt.connectors.gallery.list())).not.toContain(access as string);
      // The redactor knows them: a server echoing the token would show the mark.
      expect(rt.vault.redactor.redact(`x ${access} y`)).not.toContain(access as string);

      // A bot granted the connector gets its tools with the OAuth token.
      const bot = await createBot(rt.db, {
        name: "oauthbot",
        modelProvider: "script",
        modelId: "model-s",
      });
      await rt.connectors.grant("fakeauth", bot.id, "all");
      const offered = await rt.connectors.toolsForBot(bot.id);
      expect(offered.tools.map((t) => t.name)).toContain("conn_fakeauth__echo");
      expect(
        server.mcpAuthorizations.filter((a) => a === `Bearer ${access}`).length,
      ).toBeGreaterThan(0);

      // Disconnect: revoked at the server, gone from the vault, the connector off.
      const off = await rt.connectors.gallery.oauthDisconnect("fakeauth");
      expect(off.enabled).toBe(false);
      expect(server.revocations.length).toBeGreaterThan(0);
      expect(server.validAccessTokens()).toEqual([]);
      const left = (await rt.vault.list()).map((s) => s.name);
      expect(left).not.toContain(names.access);
      expect(left).not.toContain(names.refresh);
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "needs_login",
      });
    });

    it("a server with a public address: the browser comes back to its own route, with the same checks", async () => {
      const rt = await open(undefined, undefined, { publicUrl: "https://suup.exemplo.com/" });
      expect(rt.connectors.gallery.redirect).toBe("public");
      await oauthConnector(rt);
      const start = await rt.connectors.gallery.oauthStart("fakeauth");
      // The trailing "/" of the configuration is gone; no loopback listener is involved.
      expect(start.redirectUri).toBe("https://suup.exemplo.com/oauth/callback");
      expect(new URL(start.authorizationUrl).searchParams.get("redirect_uri")).toBe(
        start.redirectUri,
      );
      const back = new URL(await authorize(start.authorizationUrl));
      expect(`${back.origin}${back.pathname}`).toBe(start.redirectUri);
      // A state of another login is refused and spends nothing.
      const forged = new URLSearchParams(back.searchParams);
      forged.set("state", "another-state");
      expect(await rt.connectors.gallery.publicCallback(forged)).toMatchObject({ status: 400 });
      const page = await rt.connectors.gallery.publicCallback(back.searchParams);
      expect(page).toMatchObject({ status: 200 });
      expect(page?.html).toContain("Login feito");
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "connected",
      });
      expect((await rt.connectors.get("fakeauth"))?.enabled).toBe(true);
      // Used once: the same return again is refused.
      const replay = await rt.connectors.gallery.publicCallback(back.searchParams);
      expect(replay?.status).toBe(400);
      expect(replay?.html).toContain("não vale mais");
    });

    it("a public address is checked: HTTPS or this computer, nothing else; without one there is no public route", async () => {
      const bad = (publicUrl: string) => () => parseConfig(rawConfig({ server: { publicUrl } }));
      expect(bad("http://suup.exemplo.com")).toThrow("HTTPS");
      expect(bad("não é endereço")).toThrow("endereço inválido");
      expect(bad("https://suup.exemplo.com/?x=1")).toThrow("consulta");
      expect(
        parseConfig(rawConfig({ server: { publicUrl: "http://127.0.0.1:8787" } })).server,
      ).toEqual({ publicUrl: "http://127.0.0.1:8787" });
      const rt = await open();
      expect(rt.connectors.gallery.redirect).toBe("loopback");
      expect(await rt.connectors.gallery.publicCallback(new URLSearchParams("state=x"))).toBe(
        undefined,
      );
    });

    it("a public-address login fails on another issuer exactly as on the loopback", async () => {
      const rt = await open(undefined, undefined, { publicUrl: "https://suup.exemplo.com" });
      await oauthConnector(rt, { issInRedirect: "https://evil.example.com" });
      const start = await rt.connectors.gallery.oauthStart("fakeauth");
      const back = new URL(await authorize(start.authorizationUrl));
      const page = await rt.connectors.gallery.publicCallback(back.searchParams);
      expect(page?.status).toBe(400);
      expect(page?.html).toContain("outro servidor de autorização");
      expect((await rt.vault.list()).map((s) => s.name)).not.toContain(
        oauthSecretNames("fakeauth").access,
      );
    });

    it("a callback from another issuer fails the login and stores nothing", async () => {
      const rt = await open();
      await oauthConnector(rt, { issInRedirect: "https://evil.example.com" });
      const start = await rt.connectors.gallery.oauthStart("fakeauth");
      const page = await fetch(await authorize(start.authorizationUrl));
      expect(page.status).toBe(400);
      expect(await page.text()).toContain("outro servidor de autorização");
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "error",
      });
      expect((await rt.vault.list()).map((s) => s.name)).not.toContain(
        oauthSecretNames("fakeauth").access,
      );
      expect((await rt.connectors.get("fakeauth"))?.enabled).toBe(false);
    });

    it("a server without PKCE is refused before the browser opens", async () => {
      const rt = await open();
      await oauthConnector(rt, { pkceMethods: null });
      await expect(rt.connectors.gallery.oauthStart("fakeauth")).rejects.toThrow("PKCE");
      expect(await rt.connectors.gallery.oauthStatus("fakeauth")).toMatchObject({
        status: "error",
      });
    });

    it("a login expires: its state is refused after the time limit", async () => {
      const rt = await open();
      fake = await startFakeOAuthMcp();
      let clock = Date.now();
      const service = createConnectorService({
        db: () => rt.db,
        vault: rt.vault,
        oauthFlowTtlMs: 1000,
        now: () => clock,
      });
      try {
        await service.create(
          { name: "slow", transport: { kind: "http", url: fake.mcpUrl, oauth: {} } },
          { allowMissingSecrets: true },
        );
        const start = await service.gallery.oauthStart("slow");
        const back = await authorize(start.authorizationUrl);
        clock += 2000;
        const page = await fetch(back);
        expect(page.status).toBe(400);
        expect(await page.text()).toContain("não vale mais");
        expect(await service.gallery.oauthStatus("slow")).toMatchObject({ status: "error" });
        expect(fake.tokenRequests).toEqual([]);
      } finally {
        await service.close();
      }
    });

    it("propose_connector: a card with the entry; approved installs it off as a proposal; refused does nothing", async () => {
      const script = {
        agent: [
          {
            calls: [
              {
                id: "p1",
                name: PROPOSE_CONNECTOR_TOOL,
                args: { connector: "notion", reason: "para ler suas notas" },
              },
            ],
          },
          { text: "Pronto." },
        ],
      };
      const rt = await open(script);
      const bot = await createBot(rt.db, {
        name: `p-${Math.random().toString(16).slice(2, 8)}`,
        modelProvider: "script",
        modelId: "model-s",
        allowedTools: ["read_file"],
      });
      const work = (runId: string): Promise<string> =>
        new Promise((resolve) => {
          const worker = rt.createWorker({
            onlyRunId: runId,
            idleBackoff: { minMs: 10, maxMs: 50 },
            onRunEnd: (end) => {
              resolve(end.outcome === "settled" ? end.status : end.outcome);
              void worker.stop();
            },
          });
          worker.start();
        });

      // Refused: nothing is installed.
      const refused = await rt.createRun({ botId: bot.id, objective: "conecte o notion" });
      expect(await work(refused.id)).toBe("waiting_approval");
      const [card] = await listApprovals(rt.db, { runId: refused.id, status: "pending", limit: 5 });
      expect(card).toMatchObject({ tool: PROPOSE_CONNECTOR_TOOL, level: "external_irreversible" });
      expect(card?.summary).toContain("Instalar o conector Notion da galeria");
      // A sentence for the owner: no address, no link (docs/DESIGN.md, "Amigável").
      expect(card?.summary).not.toContain("https://");
      expect(card?.summary).toContain("login no navegador (OAuth)");
      await decideApproval(rt.db, card?.id as string, { decision: "denied" });
      await work(refused.id);
      expect(await rt.connectors.get("notion")).toBeNull();

      // Approved: installed off, from the gallery, as a proposal.
      const approved = await rt.createRun({ botId: bot.id, objective: "conecte o notion" });
      expect(await work(approved.id)).toBe("waiting_approval");
      const [card2] = await listApprovals(rt.db, {
        runId: approved.id,
        status: "pending",
        limit: 5,
      });
      await decideApproval(rt.db, card2?.id as string, { decision: "approved" });
      expect(await work(approved.id)).toBe("done");
      const installed = await rt.connectors.get("notion");
      expect(installed).toMatchObject({
        enabled: false,
        origin: "proposal",
        catalogId: "notion",
      });
      // The owner approved the card: the bot that proposed it was given the connector (owner, 24/11/2026).
      expect(installed?.grants).toEqual([{ botId: bot.id, all: true, tools: [] }]);
      const events = await listRunEvents(rt.db, approved.id, { limit: 1000 });
      const result = events.find(
        (e) => e.type === "tool_result" && (e.payload as { callId?: string }).callId === "p1",
      );
      expect(String((result?.payload as { content?: unknown } | undefined)?.content)).toContain(
        "Gerenciar",
      );
    });

    it("propose_connector never installs what is not in the gallery", async () => {
      const rt = await open();
      const tool = proposeConnectorTool(() => rt.connectors.gallery);
      const ctxTool = {} as Parameters<typeof tool.execute>[1];
      const out = await tool.execute({ connector: "evil", reason: "porque sim" }, ctxTool);
      expect(out.isError).toBe(true);
      const unverified = await tool.execute(
        { connector: "google-workspace", reason: "agenda" },
        ctxTool,
      );
      expect(unverified.isError).toBe(true);
      expect(await rt.connectors.list()).toEqual([]);
    });

    it("propose_connector does not propose what is installed: no card (read), and the result says what is missing", async () => {
      const rt = await open();
      const tool = proposeConnectorTool(() => rt.connectors.gallery, new Set(["notion"]));
      expect(tool.classify?.({ connector: "notion", reason: "x" }, {} as never)).toBe("read");
      expect(tool.classify?.({ connector: "github", reason: "x" }, {} as never)).toBe(
        "external_irreversible",
      );
      const bot = await createBot(rt.db, {
        name: "ana",
        modelProvider: "script",
        modelId: "model-s",
      });
      const ctx = { botId: bot.id } as Parameters<typeof tool.execute>[1];
      // Installed (off, as a proposal) and not connected: the bot is told to show the card.
      await rt.connectors.gallery.install("notion", { origin: "proposal" });
      const notConnected = await tool.execute({ connector: "notion", reason: "agenda" }, ctx);
      expect(notConnected.isError).not.toBe(true);
      expect(String(notConnected.content)).toContain("Já instalado");
      expect(String(notConnected.content)).toContain("not connected yet");
      expect(String(notConnected.content)).toContain("Gerenciar");
      expect(await rt.connectors.get("notion")).toMatchObject({ enabled: false, grants: [] });
      // A connector that was removed after the run began is not installed behind the user's back.
      const gone = proposeConnectorTool(() => rt.connectors.gallery, new Set(["github"]));
      const out = await gone.execute({ connector: "github", reason: "x" }, ctx);
      expect(out.isError).toBe(true);
      expect(await rt.connectors.get("github")).toBeNull();
    });

    it("show_connect_card only takes a link of a host the connector declares, https, no login", async () => {
      const rt = await open();
      const tool = showConnectCardTool(() => rt.connectors.gallery);
      const ctx = {} as Parameters<typeof tool.execute>[1];
      await rt.connectors.gallery.install("composio", { origin: "proposal" });
      const ok = await tool.execute(
        {
          connector: "composio",
          app: "Google Agenda",
          url: "https://connect.composio.dev/link/lk_abc?x=1",
          action: "authorize_app",
        },
        ctx,
      );
      expect(ok.isError).not.toBe(true);
      expect(String(ok.content)).toContain("card is shown");
      for (const url of [
        "http://connect.composio.dev/link/abc",
        "https://connect.composio.dev.evil.example/link/abc",
        "https://evil.example/connect.composio.dev/link/x",
        "https://user:pw@connect.composio.dev/link/s",
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
        "https://connect.composio.dev/mcp",
        "not a url",
      ]) {
        const bad = await tool.execute({ connector: "composio", url, action: "connect" }, ctx);
        expect(bad.isError, url).toBe(true);
      }
      // Only the /link/ path of the host (the first path segment compared exactly).
      const own = await tool.execute(
        { connector: "composio", url: "https://connect.composio.dev/link/lk_1", action: "connect" },
        ctx,
      );
      expect(own.isError).not.toBe(true);
      const noUrl = await tool.execute({ connector: "composio", action: "authorize_app" }, ctx);
      expect(noUrl.isError).toBe(true);
      const nothing = await tool.execute({ connector: "nao-existe", action: "manage" }, ctx);
      expect(nothing.isError).toBe(true);
      expect(String(nothing.content)).toContain("propose_connector");
      // Pure check, by exact host.
      expect(connectLinkProblem("https://a.example/x", ["a.example"])).toBeUndefined();
      expect(connectLinkProblem("https://a.example/link/x", ["a.example"], "link")).toBeUndefined();
      expect(connectLinkProblem("https://a.example/x", ["a.example"], "link")).toContain("/link/");
      expect(connectLinkProblem("https://a.example:8443/link/x", ["a.example"], "link")).toContain(
        "port",
      );
      expect(connectLinkProblem("https://b.example/x", ["a.example"])).toContain(
        "not one this connector declares",
      );
    });
  },
);
