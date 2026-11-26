import { join } from "node:path";
import { controlToolSpecs } from "@suup/core";
import { createBot, decideApproval, getRun, listApprovals, listRunEvents } from "@suup/db";
import { removeMachine } from "@suup/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { installFakeDocker } from "../../sandbox/test/fake-docker.js";
import { createRuntime, parseConfig, type Runtime } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { dockerReady, removeNetwork, SANDBOX_IMAGE } from "./docker-kit.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// The allowlist as the loop and the people use it. The docker CLI is the fake one (no daemon): what
// is under test here is the policy, the approval card and the grants, not a container.
describe.skipIf(!DATABASE_URL)(dbSuiteName("network allowlist and the approval card"), () => {
  const ctx = useIsolatedDb();

  const real = `suup-nettest-${Math.random().toString(16).slice(2, 8)}`;
  afterAll(async () => {
    if (!dockerReady) return;
    await removeMachine(real, { volume: real });
    await removeNetwork(real);
  });

  async function open(script: unknown, extra: Record<string, unknown> = {}, useDocker = false) {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    const dockerPath = useDocker ? undefined : installFakeDocker(dir);
    if (!useDocker) process.env.FAKE_DOCKER_STATE = join(dir, "state.json");
    const runtime = createRuntime(
      parseConfig(
        rawConfig({
          sandbox: {
            kind: "docker",
            image: useDocker ? (SANDBOX_IMAGE as string) : "suup-sandbox:dev",
            name: useDocker ? real : "net-machine",
            volume: useDocker ? real : "net-volume",
            // The fake docker has no bridge: its proxy listens on loopback. The real one uses the gateway.
            network: useDocker
              ? { name: real, ...extra }
              : { proxy: { listenHost: "127.0.0.1" }, ...extra },
          },
        }),
      ),
      {
        env: { DATABASE_URL: ctx.url },
        baseDir: dir,
        ...(dockerPath === undefined ? {} : { dockerPath }),
      },
    );
    const bot = await createBot(runtime.db, {
      name: `bot-${Math.random().toString(16).slice(2, 8)}`,
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["read_file"],
    });
    return { runtime, bot };
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

  it("the defaults come from the configuration and are visible", async () => {
    const { runtime, bot } = await open(
      { agent: [{ text: "x" }] },
      { defaultHosts: ["Registry.Example.com"] },
    );
    expect((await runtime.network.forBot(bot.id)).defaults).toEqual(["registry.example.com"]);
    expect(await runtime.network.policy.allowedHosts({ kind: "bot", id: bot.id })).toEqual(
      new Set(["registry.example.com"]),
    );
    await runtime.close();
  });

  it("adds, lists and removes hosts of one bot by exact name, refusing what is not a name", async () => {
    const { runtime, bot } = await open({ agent: [{ text: "x" }] });
    expect(await runtime.network.allow(bot.id, "API.Example.com.")).toEqual({
      host: "api.example.com",
      added: true,
    });
    expect((await runtime.network.allow(bot.id, "api.example.com")).added).toBe(false);
    expect((await runtime.network.forBot(bot.id)).hosts.map((h) => h.host)).toEqual([
      "api.example.com",
    ]);
    for (const bad of [
      "127.0.0.1",
      "localhost",
      "*.example.com",
      "10.0.0.1",
      "https://api.example.com",
      "",
    ]) {
      await expect(runtime.network.allow(bot.id, bad), bad).rejects.toThrow(/Host inválido/);
    }
    const other = await createBot(runtime.db, {
      name: "other",
      modelProvider: "script",
      modelId: "model-s",
    });
    expect(
      (await runtime.network.policy.allowedHosts({ kind: "bot", id: other.id })).has(
        "api.example.com",
      ),
    ).toBe(false);
    expect(await runtime.network.remove(bot.id, "api.example.com")).toBe(true);
    expect(await runtime.network.remove(bot.id, "api.example.com")).toBe(false);
    await runtime.close();
  });

  it("a connector has the defaults plus its own hosts; the harness has none", async () => {
    const { runtime } = await open({ agent: [{ text: "x" }] });
    await runtime.connectors.create({
      name: "files",
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "x"],
        env: {},
        egressHosts: ["API.Files.example.com"],
      },
    });
    const hosts = await runtime.network.policy.allowedHosts({ kind: "connector", id: "files" });
    expect([...hosts].sort()).toEqual(
      ["api.files.example.com", "files.pythonhosted.org", "pypi.org", "registry.npmjs.org"].sort(),
    );
    expect(
      (await runtime.network.policy.allowedHosts({ kind: "harness", id: "doctor" })).size,
    ).toBe(0);
    const view = await runtime.connectors.get("files");
    expect(view?.transport).toMatchObject({ egressHosts: ["api.files.example.com"] });
    // the fake docker sandbox runs connectors in a container
    expect(view?.runsIn).toBe("container");
    await expect(
      runtime.connectors.create({
        name: "bad",
        transport: { kind: "stdio", command: "npx", args: [], env: {}, egressHosts: ["10.0.0.1"] },
      }),
    ).rejects.toThrow(/IP/);
    await runtime.close();
  });

  it("request_network_access is a built-in tool of the isolated machine: the measurement counts it and tool search never defers it", async () => {
    const { runtime, bot } = await open({ agent: [{ text: "x" }] });
    // The bot allows only `read_file`; on the isolated machine it also always has the host request.
    const report = await runtime.toolReport(bot.id);
    const control = controlToolSpecs({
      secrets: runtime.vault.settings !== undefined,
      scheduleReturn: true,
    }).length;
    // read_file, the host request, `send_file` and `create_document` (a bot with a machine hands its
    // files to the chat and builds PDF, Word and Excel files),
    // the five routine tools of a conversation run (the four of docs/ROTINAS.md and
    // `create_reminder`) and the gallery proposal (`propose_connector`, docs/CONECTORES.md) and its card
    // (`show_connect_card`), and the six always-on tools: memory (four) and the web (search, read)
    // ...and `start_task` and `send_to_task` (KOD-68, docs/TAREFAS.md).
    expect(report.builtinTools).toBe(control + 4 + 5 + 2 + 6 + 2);
    expect(report.mode).toBe("direct");
    expect(report.connectorTools).toBe(0);
    expect(report.deferred).toBe(0);
    await runtime.close();
  });

  it.skipIf(!dockerReady)(
    "a host the bot asks for waits for a card; approving allows that exact host for this run only",
    async () => {
      const { runtime, bot } = await open(
        {
          agent: [
            {
              calls: [
                {
                  id: "c1",
                  name: "request_network_access",
                  args: { host: "Api.Example.com", reason: "fetch the report" },
                },
              ],
            },
            { text: "Done." },
          ],
        },
        {},
        true,
      );
      const run = await runtime.createRun({ botId: bot.id, objective: "Reach the API" });
      const deps = await runtime.buildDeps(run.id, "w-inspect");
      // the isolated machine always offers the tool, even to a bot created before it existed
      expect(deps.bot.allowedTools).toContain("request_network_access");

      expect(await work(runtime, run.id)).toBe("waiting_approval");
      const [card] = await listApprovals(runtime.db, {
        runId: run.id,
        status: "pending",
        limit: 5,
      });
      expect(card).toMatchObject({
        tool: "request_network_access",
        level: "external_irreversible",
        args: { host: "Api.Example.com", reason: "fetch the report" },
      });
      expect(card?.summary).toContain("Api.Example.com");
      // Nothing is allowed while the card waits.
      expect(
        (await runtime.network.policy.allowedHosts({ kind: "bot", id: bot.id })).has(
          "api.example.com",
        ),
      ).toBe(false);

      await decideApproval(runtime.db, card?.id as string, { decision: "approved" });
      // The grant exists while the run is not finished: check it from inside the tool's own step.
      expect(await work(runtime, run.id)).toBe("done");
      const results = (await listRunEvents(runtime.db, run.id, { limit: 100 })).filter(
        (e) => e.type === "tool_result",
      );
      expect(String(results.at(-1)?.payload.content)).toContain(
        "api.example.com is allowed for the rest of this run",
      );
      expect((await getRun(runtime.db, run.id))?.status).toBe("done");

      // The run is over: the grant no longer counts, and the bot's own list is untouched.
      expect(
        (await runtime.network.policy.allowedHosts({ kind: "bot", id: bot.id })).has(
          "api.example.com",
        ),
      ).toBe(false);
      expect((await runtime.network.forBot(bot.id)).hosts).toEqual([]);
      await runtime.close();
    },
  );

  it.skipIf(!dockerReady)("a denied card allows nothing", async () => {
    const { runtime, bot } = await open(
      {
        agent: [
          {
            calls: [
              {
                id: "c1",
                name: "request_network_access",
                args: { host: "evil.example.com", reason: "because" },
              },
            ],
          },
          { text: "Understood." },
        ],
      },
      {},
      true,
    );
    const run = await runtime.createRun({ botId: bot.id, objective: "Try" });
    expect(await work(runtime, run.id)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, { runId: run.id, status: "pending", limit: 5 });
    await decideApproval(runtime.db, card?.id as string, { decision: "denied", reason: "no" });
    expect(await work(runtime, run.id)).toBe("done");
    expect(
      (await runtime.network.policy.allowedHosts({ kind: "bot", id: bot.id })).has(
        "evil.example.com",
      ),
    ).toBe(false);
    await runtime.close();
  });

  it("stores refusals of the proxy as events and only refusals", async () => {
    const { runtime, bot } = await open({ agent: [{ text: "x" }] });
    const subject = { kind: "bot" as const, id: bot.id };
    runtime.network.record({
      subject,
      host: "a.example.com",
      port: 443,
      decision: "allowed",
      at: new Date(),
    });
    runtime.network.record({
      subject,
      host: "b.example.com",
      port: 443,
      decision: "refused",
      reason: "not_allowed",
      message: "host b.example.com is not allowed for this bot",
      at: new Date(),
    });
    await new Promise((r) => setTimeout(r, 200));
    const view = await runtime.network.forBot(bot.id);
    expect(view.refusals.map((r) => r.host)).toEqual(["b.example.com"]);
    await runtime.close();
  });
});
