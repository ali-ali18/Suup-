import { describe, expect, it } from "vitest";
import { appendRunEvent, listRunEvents } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("run events: type filter and the slim view"), () => {
  const ctx = useIsolatedDb();

  it("filters by type and cuts the heavy model_request payload in the database", async () => {
    const run = await makeRun(ctx.db);
    const huge = "x".repeat(200_000);
    await appendRunEvent(ctx.db, run.id, "run_started", { botId: "b" });
    await appendRunEvent(ctx.db, run.id, "model_request", {
      provider: "p",
      model: "m",
      system: huge,
      messages: [{ role: "user", blocks: [{ type: "text", text: huge }] }],
      tools: [{ name: "a" }, { name: "b" }],
      maxOutputTokens: 100,
      purpose: "review",
    });
    await appendRunEvent(ctx.db, run.id, "nudge", { reason: "r", text: "t" });

    const full = await listRunEvents(ctx.db, run.id);
    expect(full.map((e) => e.type)).toEqual(["run_started", "model_request", "nudge"]);
    expect(JSON.stringify(full[1]?.payload).length).toBeGreaterThan(400_000);

    const slim = await listRunEvents(ctx.db, run.id, { slim: true });
    expect(slim.map((e) => e.seq)).toEqual([1, 2, 3]); // nothing is dropped, the place is kept
    expect(slim[1]?.payload).toEqual({
      omitted: true,
      provider: "p",
      model: "m",
      purpose: "review",
      messageCount: 1,
      toolCount: 2,
    });
    expect(slim[0]?.payload).toEqual({ botId: "b" }); // everything else is untouched
    expect(slim[2]?.payload).toEqual({ reason: "r", text: "t" });

    const only = await listRunEvents(ctx.db, run.id, {
      types: ["nudge", "model_request"],
      slim: true,
      afterSeq: 1,
    });
    expect(only.map((e) => e.type)).toEqual(["model_request", "nudge"]);
    expect(await listRunEvents(ctx.db, run.id, { types: [] })).toEqual([]);
  });
});
