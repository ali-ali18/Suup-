import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeServerCommand } from "@suup/connectors/testing";
import { createBot, type Db, decideApproval, listApprovals, listRunEvents } from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  generateKeyText,
  parseConfig,
  type Runtime,
  runDoctorChecks,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const VALUE = "tok_live_Zx81qKj3Lm0pTt92abCdEf";

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

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("MCP connectors, end to end"),
  { timeout: 60_000 },
  () => {
    const ctx = useIsolatedDb();

    async function open(script: unknown, extraConfig: Record<string, unknown> = {}) {
      // The tests share one schema and the same connector names: start from none.
      await ctx.db.sql`delete from connectors`;
      await ctx.db.sql`delete from secrets`;
      const dir = await tempDir();
      await writeJson(join(dir, "script.json"), script);
      const env = { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() };
      const runtime = createRuntime(
        parseConfig(
          rawConfig({
            vault: { keyEnv: "TEST_VAULT_KEY" },
            // The tests that script direct calls of the fake server's 17 tools: search is off.
            toolSearch: { minTools: 1000, minDefinitionTokens: 1_000_000 },
            ...extraConfig,
          }),
        ),
        { env, baseDir: dir },
      );
      const bot = await createBot(runtime.db, {
        name: `bot-${Math.random().toString(16).slice(2, 8)}`,
        modelProvider: "script",
        modelId: "model-s",
        allowedTools: ["read_file"],
      });
      const log = join(dir, "connector-calls.log");
      const { command, args } = fakeServerCommand();
      const transport = {
        kind: "stdio" as const,
        command,
        args,
        env: { FAKE_LOG: log, FAKE_TOKEN: { secret: "FAKE_API" } },
      };
      const calls = (): string[] => {
        try {
          return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
        } catch {
          return [];
        }
      };
      return { runtime, dir, bot, transport, calls };
    }

    const work = (runtime: Runtime, runId: string): Promise<string> =>
      new Promise((resolve) => {
        const worker = runtime.createWorker({
          onlyRunId: runId,
          idleBackoff: { minMs: 10, maxMs: 50 },
          onRunEnd: (end) => {
            resolve(end.outcome === "settled" ? end.status : end.outcome);
            void worker.stop();
          },
        });
        worker.start();
      });

    it("a bot uses a connector's tools: read runs, write asks, the secret reaches the server and nothing else", async () => {
      const { runtime, bot, transport, calls } = await open({
        agent: [
          { calls: [{ id: "c1", name: "conn_fake__needs_secret", args: {} }] },
          {
            calls: [
              { id: "c2", name: "conn_fake__write_thing", args: { name: "report", body: "hello" } },
            ],
          },
          { text: "Done." },
        ],
      });
      await runtime.vault.set("FAKE_API", VALUE, { description: "the fake server's token" });
      await runtime.connectors.create({
        name: "fake",
        transport,
        tools: { needs_secret: { risk: "read" } },
      });
      // Not granted yet: the bot sees nothing of it.
      expect((await runtime.connectors.toolsForBot(bot.id)).tools).toEqual([]);
      await runtime.connectors.grant("fake", bot.id, "all");

      const run = await runtime.createRun({ botId: bot.id, objective: "Use the connector" });
      const deps = await runtime.buildDeps(run.id, "w-inspect");
      expect(deps.bot.allowedTools).toEqual(
        expect.arrayContaining(["read_file", "conn_fake__echo", "conn_fake__write_thing"]),
      );
      expect(deps.tools.specs(deps.bot.allowedTools).map((s) => s.name)).toContain(
        "conn_fake__needs_secret",
      );

      // The read tool ran without a card; the write tool waits for the user, with the exact arguments.
      expect(await work(runtime, run.id)).toBe("waiting_approval");
      const [card] = await listApprovals(runtime.db, {
        runId: run.id,
        status: "pending",
        limit: 5,
      });
      expect(card).toMatchObject({
        tool: "conn_fake__write_thing",
        level: "external_irreversible",
        args: { name: "report", body: "hello" },
      });
      expect(calls()).toEqual([]);

      await decideApproval(runtime.db, card?.id as string, { decision: "approved" });
      expect(await work(runtime, run.id)).toBe("done");
      expect(calls()).toEqual(['write_thing {"name":"report","body":"hello"}']);

      const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
      const results = events.filter((e) => e.type === "tool_result").map((e) => e.payload);
      // The server echoed the credential; what the log (and the model) holds is the mark, labelled as external data.
      expect(String(results[0]?.content)).toContain("credential=[REDACTED:FAKE_API]");
      expect(String(results[0]?.content)).toContain("EXTERNAL_DATA");

      // The acceptance criterion: a scan of the whole database finds no value, in any common form.
      const everything = await dump(runtime.db, ctx.schema);
      for (const form of [
        VALUE,
        Buffer.from(VALUE).toString("base64"),
        Buffer.from(VALUE).toString("base64url"),
        encodeURIComponent(VALUE),
        Buffer.from(VALUE).toString("hex"),
      ]) {
        expect(everything.includes(form), `database holds ${form.slice(0, 8)}…`).toBe(false);
      }
      // The configuration holds the NAME of the secret, never its value.
      expect(everything).toContain("FAKE_API");
      const view = await runtime.connectors.get("fake");
      expect(JSON.stringify(view)).not.toContain(VALUE);
      expect(view?.secretNames).toEqual(["FAKE_API"]);
      await runtime.close();
    });

    it("refuses a connector that names a secret the vault does not have, and a disabled one offers nothing", async () => {
      const { runtime, bot, transport } = await open({ agent: [{ text: "x" }] });
      await expect(runtime.connectors.create({ name: "fake", transport })).rejects.toThrow(
        /FAKE_API.*não existe no cofre/,
      );
      await runtime.vault.set("FAKE_API", VALUE);
      await runtime.connectors.create({ name: "fake", transport });
      await runtime.connectors.grant("fake", bot.id, "all");
      expect((await runtime.connectors.toolsForBot(bot.id)).tools.length).toBeGreaterThan(5);
      await runtime.connectors.update("fake", { enabled: false });
      expect((await runtime.connectors.toolsForBot(bot.id)).tools).toEqual([]);
      await runtime.connectors.update("fake", { enabled: true, scope: "read_only" });
      expect((await runtime.connectors.toolsForBot(bot.id)).tools).toEqual([]);
      await runtime.connectors.setToolRisk("fake", "echo", "read");
      expect((await runtime.connectors.toolsForBot(bot.id)).tools.map((t) => t.name)).toEqual([
        "conn_fake__echo",
      ]);
      // A bad configuration is a clear message, not a stack trace.
      await expect(
        runtime.connectors.update("fake", {
          transport: { kind: "stdio", command: "bash", args: ["-c", "echo hi"] },
        }),
      ).rejects.toThrow(/interpolação/);
      await runtime.close();
    });

    it("a proposal (the future path of a bot proposing a connector) is created off", async () => {
      const { runtime, transport } = await open({ agent: [{ text: "x" }] });
      await runtime.vault.set("FAKE_API", VALUE);
      const proposed = await runtime.connectors.create(
        { name: "proposed", transport, enabled: true },
        { origin: "proposal" },
      );
      expect(proposed).toMatchObject({ origin: "proposal", enabled: false });
      await runtime.close();
    });

    it("a server that is down when the run starts still offers its last known tools, and a call fails as a tool error", async () => {
      const { runtime, bot, transport } = await open({
        agent: [
          { calls: [{ id: "c1", name: "conn_fake__echo", args: { text: "hi" } }] },
          { text: "The connector is down; I could not do it." },
        ],
      });
      await runtime.vault.set("FAKE_API", VALUE);
      await runtime.connectors.create({
        name: "fake",
        transport,
        tools: { echo: { risk: "read" } },
      });
      await runtime.connectors.grant("fake", bot.id, "all");
      expect((await runtime.connectors.test("fake")).ok).toBe(true);
      // Wait for the snapshot written by the listing (it is saved in the background).
      for (let i = 0; i < 100; i++) {
        if ((await runtime.connectors.get("fake"))?.discovery.discoveredAt !== null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      // Now the program is gone.
      await runtime.connectors.update("fake", {
        transport: { ...transport, command: "/nonexistent/binary", args: [] },
      });
      const offered = await runtime.connectors.toolsForBot(bot.id);
      expect(offered.problems).toHaveLength(1);
      expect(offered.problems[0]?.message).toContain('Conector "fake"');
      expect(offered.tools.map((t) => t.name)).toContain("conn_fake__echo");

      const run = await runtime.createRun({ botId: bot.id, objective: "Echo" });
      expect(await work(runtime, run.id)).toBe("done");
      const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
      const result = events.find((e) => e.type === "tool_result");
      expect(result?.payload).toMatchObject({ outcome: "tool_error", isError: true });
      expect(String(result?.payload.content)).toContain('Conector "fake"');
      await runtime.close();
    });

    it("the doctor checks each enabled connector and names the one that fails", async () => {
      const { runtime, transport } = await open({ agent: [{ text: "x" }] });
      await runtime.vault.set("FAKE_API", VALUE);
      await runtime.connectors.create({ name: "good", transport });
      await runtime.connectors.create({
        name: "broken",
        transport: { kind: "stdio", command: "/nonexistent/binary", args: [] },
      });
      await runtime.connectors.create({ name: "idle", transport, enabled: false });
      const checks = await runDoctorChecks(runtime, { sandbox: false });
      const byName = new Map(checks.map((c) => [c.component, c]));
      expect(byName.get("Conector good")).toMatchObject({ ok: true });
      expect(byName.get("Conector good")?.detail).toContain("fake-server");
      expect(byName.get("Conector broken")?.ok).toBe(false);
      expect(byName.get("Conector broken")?.detail).toContain('Conector "broken"');
      expect(byName.get("Conector idle")?.detail).toContain("desligado");
      const skipped = await runDoctorChecks(runtime, { sandbox: false, connectors: false });
      expect(skipped.find((c) => c.component === "Conectores")?.detail).toContain(
        "não verificados",
      );
      await runtime.close();
    });
  },
);
