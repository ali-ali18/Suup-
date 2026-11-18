import { join } from "node:path";
import { archiveBot, createBot, getRun } from "@suup/db";
import { describe, expect, it } from "vitest";
import { createRuntime, parseConfig, RuntimeError } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("runtime with the database"), () => {
  const ctx = useIsolatedDb();

  const open = async (script: unknown = { agent: [{ text: "Hello." }] }) => {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    const runtime = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    return { runtime, dir };
  };

  it("refuses to create a run for an archived bot, naming it", async () => {
    const { runtime } = await open();
    const bot = await createBot(runtime.db, {
      name: "Old",
      modelProvider: "script",
      modelId: "model-s",
    });
    await archiveBot(runtime.db, bot.id);
    const attempt = runtime.createRun({ botId: bot.id, objective: "do it" });
    await expect(attempt).rejects.toBeInstanceOf(RuntimeError);
    await expect(attempt).rejects.toMatchObject({ code: "bot_archived" });
    await expect(attempt).rejects.toThrow(/"Old".*arquivado/);
    const rows = await runtime.db.sql`select id from runs where bot_id = ${bot.id}`;
    expect(rows).toHaveLength(0); // nothing was created
    await runtime.close();
  });

  it("refuses an unknown bot and a bot whose model the configuration lacks", async () => {
    const { runtime } = await open();
    await expect(
      runtime.createRun({ botId: "00000000-0000-4000-8000-000000000000", objective: "x" }),
    ).rejects.toMatchObject({ code: "bot_not_found" });

    const orphan = await createBot(runtime.db, {
      name: "Orphan",
      modelProvider: "script",
      modelId: "model-gone",
    });
    await expect(runtime.createRun({ botId: orphan.id, objective: "x" })).rejects.toThrow(
      /bot "Orphan".*"model-gone"/,
    );
    await runtime.close();
  });

  it("creates a queued user run with the criteria", async () => {
    const { runtime } = await open();
    const bot = await createBot(runtime.db, {
      name: "Ok",
      modelProvider: "script",
      modelId: "model-s",
    });
    const run = await runtime.createRun({
      botId: bot.id,
      objective: "Say hello",
      acceptanceCriteria: ["says hello"],
    });
    expect(run).toMatchObject({
      status: "queued",
      origin: "user",
      acceptanceCriteria: ["says hello"],
    });
    await runtime.close();
  });

  it("a worker made by the runtime runs a run to the end with the scripted provider", async () => {
    const { runtime } = await open({ agent: [{ text: "Hello there." }] });
    const bot = await createBot(runtime.db, {
      name: "Talker",
      modelProvider: "script",
      modelId: "model-s",
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "Greet me" });
    const ended = new Promise<string>((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: run.id,
        idleBackoff: { minMs: 10, maxMs: 50 },
        onRunEnd: (end) => {
          resolve(end.outcome);
          void worker.stop();
        },
      });
      worker.start();
    });
    expect(await ended).toBe("settled");
    const done = await getRun(runtime.db, run.id);
    expect(done?.status).toBe("done");
    expect(done?.result).toEqual({ summary: "Hello there." });
    expect(done?.turns).toBe(1);
    await runtime.close();
  });

  it("a run whose provider key is missing fails with origin provider and the variable's name", async () => {
    const { runtime } = await open();
    const bot = await createBot(runtime.db, {
      name: "Keyless",
      modelProvider: "anthropic",
      modelId: "model-x",
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "x" });
    const ended = new Promise<void>((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: run.id,
        idleBackoff: { minMs: 10, maxMs: 50 },
        onRunEnd: () => {
          resolve();
          void worker.stop();
        },
      });
      worker.start();
    });
    await ended;
    const failed = await getRun(runtime.db, run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.failureOrigin).toBe("provider");
    expect(failed?.failureDetail).toContain("auth");
    expect(failed?.failureDetail).toContain("KEY_A");
    await runtime.close();
  });

  it("builds the dependencies of a run with memory by default, and with none when isolated", async () => {
    const { runtime } = await open();
    const { addMemory } = await import("@suup/db");
    await addMemory(runtime.db, { layer: "rule", text: "Regra do usuário.", createdBy: "user" });
    const bot = await createBot(runtime.db, {
      name: "Mem",
      modelProvider: "script",
      modelId: "model-s",
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "x" });

    const normal = await runtime.buildDeps(run.id, "w1");
    expect(normal.loadRunContext).toBeTypeOf("function");
    expect(normal.memoryFor).toBeTypeOf("function");
    const snapshot = await normal.loadRunContext?.(run.id);
    expect(snapshot?.rules.map((r) => r.text)).toEqual(["Regra do usuário."]);

    // An evaluation never sees the user's memory: neither a context snapshot nor a memory service.
    const isolated = await runtime.buildDeps(run.id, "w1", { isolated: true });
    expect(isolated.loadRunContext).toBeUndefined();
    expect(isolated.memoryFor).toBeUndefined();
    expect(isolated.store).toBeDefined();
    expect(isolated.tools).toBeDefined();
    await runtime.close();
  });
});
