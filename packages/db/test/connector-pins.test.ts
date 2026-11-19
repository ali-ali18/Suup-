import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvePin,
  type ConnectorWrite,
  createBot,
  createConnector,
  getConnector,
  grantConnector,
  listConnectorEvents,
  listConnectorsForBot,
  listPins,
  MIGRATIONS_DIR,
  migrate,
  PinStaleError,
  reconcilePins,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const connector = (name: string): ConnectorWrite => ({
  name,
  description: "",
  transport: "stdio",
  command: "node",
  args: [],
  cwd: null,
  env: {},
  url: null,
  headers: {},
  scope: "read_write",
  toolOverrides: {},
  trustAnnotations: false,
  timeoutMs: null,
  enabled: true,
  origin: "user",
});
const obs = (tool: string, fingerprint: string) => ({
  tool,
  fingerprint,
  definition: { name: tool, description: fingerprint },
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0014: grants by tool"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("existing whole-connector grants become 'all tools'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0014" && f.endsWith(".sql"));
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);

    const bot = await createBot(ctx.db, { name: "antigo", modelProvider: "p", modelId: "m" });
    await ctx.db.sql`
      insert into connectors (name, transport, command) values ('legado', 'stdio', 'node')`;
    await ctx.db.sql`
      insert into connector_grants (connector_id, bot_id)
      select id, ${bot.id} from connectors where name = 'legado'`;

    expect(await migrate(ctx.db)).toEqual(held);
    const found = await getConnector(ctx.db, "legado");
    expect(found?.grants).toEqual([{ botId: bot.id, all: true, tools: [] }]);
    expect((await listConnectorsForBot(ctx.db, bot.id)).map((c) => c.name)).toEqual(["legado"]);
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("connector tool grants and pins"), () => {
  const ctx = useIsolatedDb();

  it("a grant is a set of tools; granting again replaces it", async () => {
    const bot = await createBot(ctx.db, { name: "b1", modelProvider: "p", modelId: "m" });
    await createConnector(ctx.db, connector("g1"));
    await grantConnector(ctx.db, "g1", bot.id, ["b", "a", "a"]);
    expect((await getConnector(ctx.db, "g1"))?.grants).toEqual([
      { botId: bot.id, all: false, tools: ["a", "b"] },
    ]);
    await grantConnector(ctx.db, "g1", bot.id, "all");
    expect((await getConnector(ctx.db, "g1"))?.grants).toEqual([
      { botId: bot.id, all: true, tools: [] },
    ]);
    await grantConnector(ctx.db, "g1", bot.id, []);
    expect((await getConnector(ctx.db, "g1"))?.grants).toEqual([
      { botId: bot.id, all: false, tools: [] },
    ]);
  });

  it("the first listing is the baseline; a changed definition is off until approved; changing back restores it", async () => {
    await createConnector(ctx.db, connector("p1"));
    const first = await reconcilePins(ctx.db, "p1", [obs("a", "h1"), obs("b", "h2")]);
    expect(first.pins.map((p) => [p.tool, p.status])).toEqual([
      ["a", "approved"],
      ["b", "approved"],
    ]);

    const changed = await reconcilePins(ctx.db, "p1", [obs("a", "h1"), obs("b", "h9")]);
    expect(changed.pins.find((p) => p.tool === "b")).toMatchObject({
      status: "changed",
      approvedFingerprint: "h2",
      seenFingerprint: "h9",
    });
    expect(changed.events).toEqual([{ tool: "b", kind: "changed" }]);
    // The same listing again changes nothing and writes no event.
    expect((await reconcilePins(ctx.db, "p1", [obs("b", "h9")])).events).toEqual([]);

    // Going back to what was approved restores it.
    const back = await reconcilePins(ctx.db, "p1", [obs("b", "h2")]);
    expect(back.pins.find((p) => p.tool === "b")?.status).toBe("approved");
    expect(back.events).toEqual([{ tool: "b", kind: "restored" }]);

    // Disappearing and coming back identical: untouched.
    await reconcilePins(ctx.db, "p1", [obs("a", "h1")]);
    expect((await listPins(ctx.db, "p1")).find((p) => p.tool === "b")?.status).toBe("approved");
    expect((await reconcilePins(ctx.db, "p1", [obs("a", "h1"), obs("b", "h2")])).events).toEqual(
      [],
    );
  });

  it("a tool that shows up after the baseline is new; approval needs the fingerprint that was seen", async () => {
    await createConnector(ctx.db, connector("p2"));
    await reconcilePins(ctx.db, "p2", [obs("a", "h1")]);
    const late = await reconcilePins(ctx.db, "p2", [obs("a", "h1"), obs("z", "n1")]);
    expect(late.pins.find((p) => p.tool === "z")).toMatchObject({
      status: "new",
      approvedFingerprint: null,
    });
    await expect(approvePin(ctx.db, "p2", "z", "n0")).rejects.toBeInstanceOf(PinStaleError);
    const ok = await approvePin(ctx.db, "p2", "z", "n1");
    expect(ok).toMatchObject({ status: "approved", approvedFingerprint: "n1" });
    const kinds = (await listConnectorEvents(ctx.db, "p2")).map((e) => e.kind);
    expect(kinds).toEqual(["approved", "new", "baseline"]);
  });

  it("an empty first listing is not a baseline: tools that come later are new, not trusted", async () => {
    await createConnector(ctx.db, connector("p3"));
    await reconcilePins(ctx.db, "p3", []);
    const later = await reconcilePins(ctx.db, "p3", [obs("a", "h1")]);
    expect(later.pins.find((p) => p.tool === "a")?.status).toBe("new");
  });
});
