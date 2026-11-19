import { describe, expect, it } from "vitest";
import { createToolGate, type GateCall } from "./gate.js";
import type { AutoReviewer, ReviewCall } from "./reviewer.js";
import { levelReviewer } from "./reviewer.js";

const executor = {} as GateCall["executor"];
const assess = (level: "read" | "external_irreversible") => ({
  assess: () => ({ level, args: { q: 1 }, summary: "do it", secrets: [] }),
});
const call = (): GateCall => ({
  runId: "r",
  callId: "c",
  botId: "b",
  name: "t",
  args: { q: 1 },
  executor,
});
const gateWith = (reviewer: AutoReviewer, level: "read" | "external_irreversible" = "read") =>
  createToolGate({
    tools: assess(level),
    rules: { rulesFor: async () => [] },
    reviewer,
    now: () => new Date(0),
  });

describe("the reviewer contract (a model-based reviewer must keep it)", () => {
  it("is given the proposed call and nothing else: no tool result, no history", async () => {
    let seen: ReviewCall | undefined;
    await gateWith({
      review: async (c) => {
        seen = c;
        return { verdict: "safe" };
      },
    }).check(call());
    expect(Object.keys(seen ?? {}).sort()).toEqual(["args", "botId", "level", "summary", "tool"]);
  });

  it("an error means ask the user, even for a plain read", async () => {
    const verdict = await gateWith({
      review: async () => {
        throw new Error("model unavailable");
      },
    }).check(call());
    expect(verdict).toMatchObject({ outcome: "ask", source: "reviewer" });
  });

  it("a missing or unknown verdict means ask the user, never allow", async () => {
    for (const bad of [undefined, null, {}, { verdict: "approve" }]) {
      const verdict = await gateWith({ review: async () => bad as never }).check(call());
      expect(verdict, JSON.stringify(bad)).toMatchObject({ outcome: "ask" });
    }
  });

  it("is awaited before the verdict exists: nothing is decided while it is pending", async () => {
    let release: (() => void) | undefined;
    const slow: AutoReviewer = {
      review: () =>
        new Promise((resolve) => {
          release = () => resolve({ verdict: "safe" });
        }),
    };
    let done = false;
    const pending = gateWith(slow)
      .check(call())
      .then((v) => {
        done = true;
        return v;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release?.();
    expect((await pending)?.outcome).toBe("allow");
  });

  it("a 'safe' never allows an irreversible action; the default only maps the level", async () => {
    const verdict = await gateWith(
      { review: async () => ({ verdict: "safe" }) },
      "external_irreversible",
    ).check(call());
    expect(verdict?.outcome).toBe("ask");
    expect(
      await levelReviewer.review({ botId: "b", tool: "t", args: {}, level: "read", summary: "" }),
    ).toEqual({
      verdict: "safe",
    });
  });
});
