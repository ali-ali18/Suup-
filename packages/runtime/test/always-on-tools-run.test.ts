import { join } from "node:path";
import { createBot } from "@suup/db";
import { describe, expect, it } from "vitest";
import { createRuntime, parseConfig } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// Memory and search are always offered to a bot, whatever it was granted; an isolated run (an
// evaluation) runs without memory and offers none of them.
const ALWAYS = ["remember", "recall", "forget", "search_conversations", "web_search", "web_read"];

describe.skipIf(!DATABASE_URL)(dbSuiteName("always-on memory and search tools"), () => {
  const ctx = useIsolatedDb();

  it("a bot with no grants is offered memory and search in a normal run and in the measurement, not in an isolated run", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [{ text: "Oi!" }] });
    const runtime = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    const bot = await createBot(runtime.db, {
      name: "Sem concessões",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: [],
    });
    const normal = await runtime.createRun({ botId: bot.id, objective: "Oi" });
    const deps = await runtime.buildDeps(normal.id, "w-inspect");
    expect(deps.bot.allowedTools).toEqual(expect.arrayContaining(ALWAYS));
    // not the tools that stay by grant
    for (const n of ["shell", "read_file", "write_file", "web_fetch"]) {
      expect(deps.bot.allowedTools).not.toContain(n);
    }
    const isolated = await runtime.createRun({ botId: bot.id, objective: "Oi", isolated: true });
    const isolatedDeps = await runtime.buildDeps(isolated.id, "w-inspect");
    for (const n of ALWAYS) expect(isolatedDeps.bot.allowedTools).not.toContain(n);

    // the measurement offers the same: a bot granted all of them is measured the same
    const granted = await createBot(runtime.db, {
      name: "Com concessões",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ALWAYS,
    });
    expect((await runtime.toolReport(bot.id)).builtinTools).toBe(
      (await runtime.toolReport(granted.id)).builtinTools,
    );
    await runtime.close();
  });
});
