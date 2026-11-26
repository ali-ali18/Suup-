import { createModelReviewer, REVIEW_TOOL_NAME } from "@suup/core";
import { FakeProvider, type FakeStep, type RecordedRequest } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { JUDGED_BATTERY, JUDGED_CLASSES, type JudgedCase, runJudgedBattery } from "../src/index.js";

// The judged battery in SCRIPTED mode (no model, no cost): it checks that the battery is well
// formed and that the harness turns answers into the right outcomes. How a REAL model does is
// measured by hand (docs/TESTES-REAIS.md).

const textOf = (req: RecordedRequest): string => {
  const block = req.messages[0]?.blocks[0];
  return block?.type === "text" ? block.text : "";
};
const caseOf = (text: string): JudgedCase => {
  const found = JUDGED_BATTERY.find((c) =>
    text.includes(
      JSON.stringify(Object.values(c.args)[0])
        .slice(1, -1)
        .replaceAll("<", "\\u003c")
        .replaceAll('"', '\\"'),
    ),
  );
  if (found === undefined) throw new Error("a request about no case");
  return found;
};

function reviewerThat(answer: (c: JudgedCase) => Record<string, string | boolean | null>) {
  const step: FakeStep = (req: RecordedRequest) => ({
    blocks: [
      { type: "tool_call", id: "r", name: REVIEW_TOOL_NAME, args: answer(caseOf(textOf(req))) },
    ],
    usage: { inputTokens: 1000, outputTokens: 40 },
  });
  return createModelReviewer({
    provider: new FakeProvider(Array.from({ length: 100 }, () => step)),
    model: { id: "scripted", maxOutputTokens: 400 },
  });
}

const ideal = (c: JudgedCase) =>
  c.expect === "run"
    ? {
        decision: "run",
        ruleId: null,
        reason: "ok",
        scope:
          c.kind === "local_shell" ? "inside_bot_folder_reversible" : "public_page_no_user_data",
        reversible: true,
      }
    : {
        decision: "ask",
        ruleId: null,
        reason: "pergunta",
        scope: "other",
        reversible: c.irreversible !== true,
      };

describe("the judged battery is well formed", () => {
  it("has the three classes, unique ids, both kinds, and expectations for every class", () => {
    expect(new Set(JUDGED_BATTERY.map((c) => c.id)).size).toBe(JUDGED_BATTERY.length);
    for (const klass of JUDGED_CLASSES) {
      expect(JUDGED_BATTERY.filter((c) => c.klass === klass).length).toBeGreaterThanOrEqual(8);
    }
    expect(
      JUDGED_BATTERY.filter((c) => c.klass !== "benign").every((c) => c.expect === "stop"),
    ).toBe(true);
    expect(
      JUDGED_BATTERY.filter((c) => c.klass === "benign").every((c) => c.expect === "run"),
    ).toBe(true);
    expect(new Set(JUDGED_BATTERY.map((c) => c.kind))).toEqual(
      new Set(["local_shell", "unseen_web_page"]),
    );
  });
});

describe("the harness over scripted reviewers", () => {
  it("an ideal reviewer gets every case right and no grant leak", async () => {
    const report = await runJudgedBattery({ reviewer: reviewerThat(ideal), model: "scripted" });
    expect(report.cases).toHaveLength(JUDGED_BATTERY.length);
    expect(report.classes.flatMap((c) => c.wrongIds)).toEqual([]);
  });
  it("a reviewer that says run without the scope never lets anything through", async () => {
    const report = await runJudgedBattery({
      reviewer: reviewerThat(() => ({ decision: "run", ruleId: null, reason: "x" })),
      model: "scripted",
    });
    expect(report.cases.every((r) => r.outcome === "ask")).toBe(true);
  });
  it("a reviewer that says the right scope but the wrong KIND of scope never lets anything through", async () => {
    const report = await runJudgedBattery({
      reviewer: reviewerThat((c) => ({
        decision: "run",
        ruleId: null,
        reason: "x",
        scope:
          c.kind === "local_shell" ? "public_page_no_user_data" : "inside_bot_folder_reversible",
      })),
      model: "scripted",
    });
    expect(report.cases.every((r) => r.outcome === "ask")).toBe(true);
  });
  it("a reviewer that always fails asks about everything", async () => {
    const report = await runJudgedBattery({
      reviewer: createModelReviewer({
        provider: new FakeProvider([]),
        model: { id: "x", maxOutputTokens: 100 },
      }),
      model: "failing",
    });
    expect(report.cases.every((r) => r.outcome === "ask")).toBe(true);
  });
  it("a grant leak is counted when an irreversible call is said to be reversible", async () => {
    const report = await runJudgedBattery({
      reviewer: reviewerThat((c) => ({ ...ideal(c), reversible: true })),
      model: "scripted",
    });
    expect(report.classes.reduce((s, c) => s + c.grantLeaks, 0)).toBeGreaterThan(0);
  });
});
