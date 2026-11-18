import { describe, expect, it } from "vitest";
import { buildSystemPrompt, renderStateReminder } from "./prompts.js";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("system prompt", () => {
  const prompt = buildSystemPrompt({ name: "Ada", personality: "Dry and precise." });

  it("is short enough to be followed", () => {
    expect(words(buildSystemPrompt({ name: "Ada", personality: "" }))).toBeLessThanOrEqual(490);
  });

  it("carries the bot's identity and the harness rules", () => {
    expect(prompt).toContain("You are Ada");
    expect(prompt).toContain("Dry and precise.");
    expect(prompt).toContain("language the user writes in");
    for (const needle of ["`plan`", "`finish`", "`escalate`", "STATE REMINDER", "EXTERNAL_DATA"]) {
      expect(prompt).toContain(needle);
    }
  });
});

describe("state reminder", () => {
  it("lists objective, numbered criteria, plan and open steps", () => {
    const text = renderStateReminder({
      objective: "Ship it",
      acceptanceCriteria: ["tests green", "docs"],
      plan: [
        { id: "a", title: "Build", status: "done" },
        { id: "b", title: "Test", status: "in_progress", note: "flaky" },
      ],
    });
    expect(text).toContain("Ship it");
    expect(text).toContain("1. tests green\n2. docs");
    expect(text).toContain("[done] a: Build");
    expect(text).toContain("[in_progress] b: Test (flaky)");
    expect(text).toContain("1 step(s) still open: b");
  });
});
