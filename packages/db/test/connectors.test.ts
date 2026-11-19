import { describe, expect, it } from "vitest";
import {
  ConnectorNameTakenError,
  ConnectorNotFoundError,
  type ConnectorWrite,
  createBot,
  createConnector,
  deleteConnector,
  getConnector,
  getConnectorDiscovery,
  grantConnector,
  listConnectors,
  listConnectorsForBot,
  replaceConnector,
  revokeConnector,
  saveConnectorDiscovery,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const stdio = (name: string, over: Partial<ConnectorWrite> = {}): ConnectorWrite => ({
  name,
  description: "",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  cwd: null,
  env: { TOKEN: { secret: "GITHUB_TOKEN" }, LOG: "debug" },
  url: null,
  headers: {},
  scope: "read_write",
  toolOverrides: {},
  trustAnnotations: false,
  timeoutMs: null,
  enabled: true,
  origin: "user",
  ...over,
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("connectors' rows"), () => {
  const ctx = useIsolatedDb();
  const newBot = (name: string) => createBot(ctx.db, { name, modelProvider: "p", modelId: "m" });

  it("stores the configuration and references to secrets (by name), and reads it back", async () => {
    const created = await createConnector(ctx.db, stdio("github"));
    expect(created).toMatchObject({
      name: "github",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: { secret: "GITHUB_TOKEN" }, LOG: "debug" },
      scope: "read_write",
      enabled: true,
      origin: "user",
      grantedBotIds: [],
    });
    expect(await getConnector(ctx.db, "github")).toEqual(created);
    expect((await listConnectors(ctx.db)).map((c) => c.name)).toContain("github");
    expect(await getConnector(ctx.db, "nope")).toBeNull();
  });

  it("names are unique and shaped, and a transport needs its own columns", async () => {
    await createConnector(ctx.db, stdio("dup"));
    await expect(createConnector(ctx.db, stdio("dup"))).rejects.toBeInstanceOf(
      ConnectorNameTakenError,
    );
    await expect(createConnector(ctx.db, stdio("Bad_Name"))).rejects.toThrow();
    await expect(createConnector(ctx.db, stdio("nocmd", { command: null }))).rejects.toThrow();
    await expect(
      createConnector(ctx.db, stdio("both", { url: "https://example.com/mcp" })),
    ).rejects.toThrow();
    const http = await createConnector(
      ctx.db,
      stdio("remote", {
        transport: "http",
        command: null,
        args: [],
        env: {},
        url: "https://example.com/mcp",
        headers: { Authorization: { secret: "API_TOKEN", prefix: "Bearer " } },
        scope: "read_only",
        toolOverrides: { search: { risk: "read" } },
        trustAnnotations: true,
        timeoutMs: 20_000,
      }),
    );
    expect(http).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
      scope: "read_only",
      toolOverrides: { search: { risk: "read" } },
      trustAnnotations: true,
      timeoutMs: 20_000,
    });
  });

  it("grants are per bot, idempotent, and disappear with the connector", async () => {
    await createConnector(ctx.db, stdio("grants"));
    const a = await newBot("a");
    const b = await newBot("b");
    await grantConnector(ctx.db, "grants", a.id);
    await grantConnector(ctx.db, "grants", a.id);
    await grantConnector(ctx.db, "grants", b.id);
    expect((await getConnector(ctx.db, "grants"))?.grantedBotIds.sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await listConnectorsForBot(ctx.db, a.id)).map((c) => c.name)).toEqual(["grants"]);
    expect(await revokeConnector(ctx.db, "grants", a.id)).toBe(true);
    expect(await revokeConnector(ctx.db, "grants", a.id)).toBe(false);
    expect(await listConnectorsForBot(ctx.db, a.id)).toEqual([]);
    await expect(grantConnector(ctx.db, "missing", a.id)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
    expect(await deleteConnector(ctx.db, "grants")).toBe(true);
    expect(await deleteConnector(ctx.db, "grants")).toBe(false);
    expect(await listConnectorsForBot(ctx.db, b.id)).toEqual([]);
  });

  it("a disabled connector is not offered to the bot, and a grant survives replacing the configuration", async () => {
    await createConnector(ctx.db, stdio("toggle"));
    const bot = await newBot("t");
    await grantConnector(ctx.db, "toggle", bot.id);
    const before = (await getConnector(ctx.db, "toggle"))?.updatedAt as Date;
    const {
      name: _n,
      origin: _o,
      ...rest
    } = stdio("toggle", { enabled: false, scope: "read_only" });
    const replaced = await replaceConnector(ctx.db, "toggle", rest);
    expect(replaced).toMatchObject({ enabled: false, scope: "read_only", grantedBotIds: [bot.id] });
    expect(replaced.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await listConnectorsForBot(ctx.db, bot.id)).toEqual([]);
    await expect(replaceConnector(ctx.db, "none", rest)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
  });

  it("what was seen of the server is kept apart: saving it does not change the configuration's version", async () => {
    const created = await createConnector(ctx.db, stdio("seen"));
    expect(await getConnectorDiscovery(ctx.db, "seen")).toEqual({
      tools: null,
      discoveredAt: null,
      lastError: null,
      lastErrorAt: null,
    });
    await saveConnectorDiscovery(ctx.db, "seen", { tools: [{ name: "echo" }] });
    await saveConnectorDiscovery(ctx.db, "seen", { error: "boom" });
    const seen = await getConnectorDiscovery(ctx.db, "seen");
    expect(seen?.tools).toEqual([{ name: "echo" }]);
    expect(seen?.lastError).toBe("boom");
    await saveConnectorDiscovery(ctx.db, "seen", { tools: [] });
    expect((await getConnectorDiscovery(ctx.db, "seen"))?.lastError).toBeNull();
    expect((await getConnector(ctx.db, "seen"))?.updatedAt).toEqual(created.updatedAt);
    expect(await getConnectorDiscovery(ctx.db, "none")).toBeNull();
  });
});
