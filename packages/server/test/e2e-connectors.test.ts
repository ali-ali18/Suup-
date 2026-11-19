import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeServerCommand } from "@suup/connectors/testing";
import { generateKeyText } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// MCP connectors through the API: the user configures one over HTTP, a worker in ANOTHER runtime
// connects (lazily, to a real child process: the fake server) and uses its tools, with the same
// approvals and the same secret hygiene as any tool.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const VALUE = "conn_live_Q1w2E3r4T5y6U7i8";

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-CONNECTOR",
        agent: [
          s({ calls: [{ name: "conn_fake__needs_secret", args: {} }] }),
          s({
            calls: [{ name: "conn_fake__write_thing", args: { name: "relatorio", body: "oi" } }],
          }),
          s({ text: "Feito." }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("MCP connectors through the API"),
  { timeout: 90_000 },
  () => {
    const w = useWorld({
      scripts: SCRIPTS,
      config: { approvals: {}, vault: { keyEnv: "SERVER_TEST_VAULT_KEY" } },
      env: { SERVER_TEST_VAULT_KEY: generateKeyText() },
    });
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "no error",
        (error: { code?: string }) => error.code ?? String(error),
      );

    it("creates, lists, edits, grants and removes a connector; no response holds a credential", async () => {
      const { api } = w.started;
      const { command, args } = fakeServerCommand();
      const log = join(w.dir, "connector-calls.log");
      const transport = {
        kind: "stdio" as const,
        command,
        args,
        env: { FAKE_LOG: log, FAKE_TOKEN: { secret: "FAKE_API" } },
      };

      // The secret has to exist first, with a clear message when it does not.
      expect(await code(api.connectors.create({ name: "fake", transport, tools: {} }))).toBe(
        "invalid_request",
      );
      await api.vault.set("FAKE_API", { value: VALUE });

      const bot = await api.bots.create({
        name: "Conectado",
        modelId: "model-x",
        allowedTools: [],
      });
      const created = await api.connectors.create({
        name: "fake",
        description: "o servidor de teste",
        transport,
        tools: { needs_secret: { risk: "read" } },
        grantBotIds: [bot.id],
      });
      expect(created).toMatchObject({
        name: "fake",
        enabled: true,
        origin: "user",
        scope: "read_write",
        secretNames: ["FAKE_API"],
        grantedBotIds: [bot.id],
        tools: null,
      });
      expect(await code(api.connectors.create({ name: "fake", transport }))).toBe("conflict");
      expect(await code(api.connectors.create({ name: "Bad_Name", transport }))).toBe(
        "invalid_request",
      );
      expect(
        await code(
          api.connectors.create({
            name: "shelly",
            transport: { kind: "stdio", command: "bash", args: ["-c", "echo hi"] },
          }),
        ),
      ).toBe("invalid_request");
      expect(await code(api.connectors.get("nope"))).toBe("not_found");

      // The server starts the program from scratch (here, where the server runs) and lists the tools.
      const tested = await api.connectors.test("fake");
      expect(tested).toMatchObject({ ok: true, serverName: "fake-server", error: null });
      const byTool = new Map(tested.tools.map((t) => [t.tool, t]));
      expect(byTool.get("needs_secret")).toMatchObject({
        name: "conn_fake__needs_secret",
        risk: "read",
        riskBasis: "user",
        available: true,
      });
      expect(byTool.get("write_thing")).toMatchObject({
        risk: "external_irreversible",
        riskBasis: "default",
      });
      expect(byTool.get("bad_all_of")).toMatchObject({ available: false });
      expect(byTool.get("bad_all_of")?.reason).toMatch(/allOf/);
      // What the model would be told is cleaned and bounded.
      expect(byTool.get("poisoned")?.description.length).toBeLessThanOrEqual(801);

      // The listing is saved (by the process that listed it), so any process can show the tools.
      const listed = await until(async () => {
        const [c] = (await api.connectors.list()).filter((x) => x.name === "fake");
        return c?.tools === null ? undefined : c;
      }, "the saved tool list");
      expect(listed?.tools?.length).toBe(tested.tools.length);

      // Mark another tool as a read, change the scope, then change it back.
      const marked = await api.connectors.setToolRisk("fake", "echo", { risk: "read" });
      expect(marked.toolOverrides).toEqual({
        needs_secret: { risk: "read" },
        echo: { risk: "read" },
      });
      expect(marked.tools?.find((t) => t.tool === "echo")).toMatchObject({ risk: "read" });
      const readOnly = await api.connectors.update("fake", { scope: "read_only" });
      expect(
        readOnly.tools
          ?.filter((t) => t.available)
          .map((t) => t.tool)
          .sort(),
      ).toEqual(["echo", "needs_secret"]);
      await api.connectors.update("fake", { scope: "read_write", timeoutMs: 30_000 });
      expect((await api.connectors.get("fake")).timeoutMs).toBe(30_000);
      const cleared = await api.connectors.setToolRisk("fake", "echo", { risk: null });
      expect(cleared.toolOverrides).toEqual({ needs_secret: { risk: "read" } });

      // Grants.
      const other = await api.bots.create({ name: "Outro", modelId: "model-x", allowedTools: [] });
      expect((await api.connectors.grant("fake", other.id)).grantedBotIds).toContain(other.id);
      expect((await api.connectors.revoke("fake", other.id)).grantedBotIds).toEqual([bot.id]);
      expect(await code(api.connectors.grant("fake", "00000000-0000-4000-8000-000000000000"))).toBe(
        "not_found",
      );

      // Nothing the API returns holds the credential: a connector only names its secrets.
      expect(JSON.stringify(await api.connectors.list())).not.toContain(VALUE);

      // The doctor names the connector.
      const doctor = await api.diagnostics.doctor();
      expect(doctor.checks.find((c) => c.component === "Conector fake")).toMatchObject({
        ok: true,
      });
    });

    it("a worker in another process uses its tools: the read runs, the write waits for the card", async () => {
      const { api } = w.started;
      const log = join(w.dir, "connector-calls.log");
      const [bot] = (await api.bots.list()).filter((b) => b.name === "Conectado");
      expect(bot).toBeDefined();
      const conversation = await api.bots.openConversation(bot?.id as string);
      const sent = await api.conversations.send(conversation.id, "CASE-CONNECTOR por favor");
      const runId = sent.run.id;

      const card = await until(async () => {
        const [c] = await api.approvals.list({ status: "pending", runId });
        return c;
      }, "the approval card");
      expect(card).toMatchObject({
        tool: "conn_fake__write_thing",
        level: "external_irreversible",
        args: { name: "relatorio", body: "oi" },
      });
      expect(card.summary).toContain("Conector fake → write_thing");
      expect(() => readFileSync(log, "utf8")).toThrow(); // nothing sent yet

      await api.approvals.decide(card.id, { decision: "approve" });
      await until(
        async () => (await api.runs.get(runId)).status === "done" || undefined,
        "the run to finish",
      );
      expect(readFileSync(log, "utf8").trim()).toBe('write_thing {"name":"relatorio","body":"oi"}');

      const events = (await api.runs.events(runId, { limit: 1000 })).items;
      const results = events.filter((e) => e.type === "tool_result").map((e) => e.payload);
      expect(String(results[0]?.content)).toContain("credential=[REDACTED:FAKE_API]");
      expect(JSON.stringify(events)).not.toContain(VALUE);
    });

    it("a removed connector is gone for the bots, and the removal is clean", async () => {
      const { api } = w.started;
      await api.connectors.remove("fake");
      expect(await code(api.connectors.remove("fake"))).toBe("not_found");
      expect((await api.connectors.list()).map((c) => c.name)).not.toContain("fake");
    });

    it("needs the token like every other route", async () => {
      const response = await fetch(`${w.started.url}/v1/connectors`);
      expect(response.status).toBe(401);
    });
  },
);
