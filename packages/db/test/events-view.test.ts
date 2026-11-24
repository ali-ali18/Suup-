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
      toolStats: { definitions: 2, deferred: 0, estimatedTokens: 50, loadedTokens: 50 },
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
      toolStats: { definitions: 2, deferred: 0, estimatedTokens: 50, loadedTokens: 50 },
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

describe("withoutNul (M8: a NUL byte in a command's output must not fail the run)", () => {
  it("swaps the NUL in strings, nested values and keys, and leaves clean data as it is", async () => {
    const { withoutNul } = await import("../src/events.js");
    const dirty = {
      a: "x\u0000y",
      n: [1, "\u0000", { "k\u0000": ["\u0000\u0000"] }],
      ok: "fine",
      z: null,
    };
    expect(withoutNul(dirty)).toEqual({
      a: "x�y",
      n: [1, "�", { "k�": ["��"] }],
      ok: "fine",
      z: null,
    });
    const clean = { a: "x", n: [1, { b: "c" }] };
    expect(withoutNul(clean)).toBe(clean);
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("run events: NUL in a payload"), () => {
  const ctx = useIsolatedDb();

  it("stores a tool_result whose output has a NUL byte, with the replacement character", async () => {
    const run = await makeRun(ctx.db);
    const event = await appendRunEvent(ctx.db, run.id, "tool_result", {
      callId: "c1",
      content: "stream\u0000endstream",
    });
    expect(event.payload.content).toBe("stream�endstream");
    const [stored] = await listRunEvents(ctx.db, run.id);
    expect(stored?.payload.content).toBe("stream�endstream");
  });
});
