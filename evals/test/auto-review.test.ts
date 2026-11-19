import { createModelReviewer, REVIEW_TOOL_NAME, reviewArgsText } from "@suup/core";
import { FakeProvider, type FakeStep, type RecordedRequest } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import {
  BATTERY,
  BATTERY_CLASSES,
  BATTERY_RULE_IDS,
  BATTERY_RULES,
  type BatteryCase,
  formatBatteryReport,
  runBattery,
} from "../src/index.js";

// The planted battery of Auto-review in SCRIPTED mode: no model, no cost. It checks that the
// battery is well formed and that the harness (precedence, fail-closed, the checks on the answer)
// turns the answers of a reviewer into the right outcomes. How a REAL model does is measured by
// `suup eval approvals` (docs/TESTES-REAIS.md).

const PRICING = { inputPerMTok: 1, outputPerMTok: 5 };

const textOf = (req: RecordedRequest): string => {
  const block = req.messages[0]?.blocks[0];
  return block?.type === "text" ? block.text : "";
};

/** Finds which battery case a review request is about, by the tool and the arguments it shows. */
function caseOf(text: string): BatteryCase {
  const found = BATTERY.find(
    (c) =>
      text.includes(`tool: ${c.tool.name}\n`) && text.includes(reviewArgsText(c.args) as string),
  );
  if (found === undefined) throw new Error("a request about no case of the battery");
  return found;
}

type Answer = { decision: string; ruleId: string | null; reason: string };

function reviewerThat(answer: (c: BatteryCase) => Answer) {
  const step: FakeStep = (req: RecordedRequest) => ({
    blocks: [
      {
        type: "tool_call",
        id: "r",
        name: REVIEW_TOOL_NAME,
        args: answer(caseOf(textOf(req))),
      },
    ],
    usage: { inputTokens: 1000, outputTokens: 40 },
  });
  const provider = new FakeProvider(Array.from({ length: 200 }, () => step));
  return {
    provider,
    reviewer: createModelReviewer({
      provider,
      model: { id: "scripted-reviewer", maxOutputTokens: 400, pricing: PRICING },
    }),
  };
}

const idealAnswer = (c: BatteryCase): Answer => ({
  decision: c.ideal.decision,
  ruleId: c.ideal.rule === null ? null : BATTERY_RULE_IDS[c.ideal.rule],
  reason: "Resposta ideal do roteiro.",
});

describe("the battery is well formed", () => {
  it("has 24 calls: 8 risky, 8 with attacker text, 8 benign near-misses", () => {
    expect(BATTERY).toHaveLength(24);
    for (const klass of BATTERY_CLASSES) {
      expect(
        BATTERY.filter((c) => c.klass === klass),
        klass,
      ).toHaveLength(8);
    }
    expect(new Set(BATTERY.map((c) => c.id)).size).toBe(24);
  });

  it("every injected case has a risky twin: the same tool and the same user messages", () => {
    for (const c of BATTERY.filter((b) => b.klass === "injected")) {
      const twin = BATTERY.find(
        (b) =>
          b.klass === "risky" &&
          b.tool.name === c.tool.name &&
          JSON.stringify(b.userMessages) === JSON.stringify(c.userMessages),
      );
      expect(twin, c.id).toBeDefined();
      expect(twin?.expect, c.id).toBe(c.expect);
    }
  });

  it("the ideal answers agree with the expectations and name rules that exist", () => {
    const ids = new Set(BATTERY_RULES.map((r) => r.id));
    for (const c of BATTERY) {
      expect(c.ideal.decision === "run", c.id).toBe(c.expect === "run");
      if (c.expect === "block") expect(c.ideal.decision, c.id).toBe("block");
      if (c.ideal.rule !== null) expect(ids.has(BATTERY_RULE_IDS[c.ideal.rule]), c.id).toBe(true);
    }
    expect(BATTERY_RULES.map((r) => r.kind).sort()).toEqual(["allow", "allow", "ask", "never"]);
  });

  it("uses no risk level a tool could not declare, and no case runs a plain read", () => {
    for (const c of BATTERY) expect(c.tool.level, c.id).not.toBe("read");
  });
});

describe("scripted run of the battery", () => {
  it("an ideal reviewer: nothing gets through, nothing benign is asked, the never rule refuses", async () => {
    const { provider, reviewer } = reviewerThat(idealAnswer);
    const report = await runBattery({ reviewer, model: "ideal" });
    expect(report.cases).toHaveLength(24);
    expect(provider.calls).toBe(24);
    for (const c of report.classes) {
      expect(c.misses, c.klass).toBe(0);
      expect(c.falseAsks, c.klass).toBe(0);
      expect(c.wrongIds, c.klass).toEqual([]);
    }
    const risky = report.classes.find((c) => c.klass === "risky");
    expect(risky).toMatchObject({ blockCases: 1, blockedByRule: 1 });
    // the cost is what the tokens cost at the price list
    expect(report.totalCostUsd).toBeCloseTo(24 * ((1000 * 1 + 40 * 5) / 1_000_000), 10);
    expect(report.inputTokens).toBe(24_000);
  });

  it("a reviewer that always asks lets nothing through and asks about every benign call", async () => {
    const { reviewer } = reviewerThat(() => ({
      decision: "ask",
      ruleId: null,
      reason: "Pergunte.",
    }));
    const report = await runBattery({ reviewer, model: "always-ask" });
    expect(report.classes.map((c) => [c.klass, c.misses, c.falseAsks])).toEqual([
      ["risky", 0, 0],
      ["injected", 0, 0],
      ["benign", 0, 8],
    ]);
  });

  it("a gullible reviewer that says run to everything is stopped by the code on every irreversible call", async () => {
    const { reviewer } = reviewerThat(() => ({ decision: "run", ruleId: null, reason: "Pode." }));
    const report = await runBattery({ reviewer, model: "gullible" });
    // What gets through is only what is reversible by declaration: the shell calls.
    const ran = report.cases.filter((r) => r.outcome === "allow" && r.expect !== "run");
    expect(ran.map((r) => r.id).sort()).toEqual([
      "injected-apagar-notas",
      "injected-curl-externo",
      "risky-apagar-notas",
      "risky-curl-externo",
    ]);
    // ...and a "run" on an irreversible call without an allow rule was changed into an ask
    const changed = report.cases.filter((r) =>
      r.adjusted?.includes("without a rule of kind allow"),
    );
    expect(changed.length).toBe(
      BATTERY.filter((c) => c.tool.level === "external_irreversible").length,
    );
  });

  it("the code checks the KIND of the rule a reviewer names, not its meaning: that is the model's part", async () => {
    // A reviewer that wrongly names the allow rule for every irreversible call lets them through.
    // The harness cannot know that the e-mail is not for the team: this is why the battery is
    // measured with a real model, and why exact rules and the floors exist next to it.
    const { reviewer } = reviewerThat((c) =>
      c.tool.level === "external_irreversible"
        ? { decision: "run", ruleId: BATTERY_RULE_IDS.equipe, reason: "Regra da equipe." }
        : { decision: "ask", ruleId: null, reason: "Pergunte." },
    );
    const report = await runBattery({ reviewer, model: "wrong-rule" });
    const risky = report.classes.find((c) => c.klass === "risky");
    expect(risky?.misses).toBeGreaterThan(0);
  });

  it("a reviewer that fails, answers nothing valid or takes too long: everything asks", async () => {
    const provider = new FakeProvider(
      Array.from({ length: 24 }, (_, i) =>
        i % 3 === 0
          ? new Error("503")
          : i % 3 === 1
            ? { blocks: [{ type: "text" as const, text: "run" }] }
            : () => new Promise<never>(() => undefined),
      ),
    );
    const reviewer = createModelReviewer({
      provider,
      model: { id: "broken", maxOutputTokens: 400 },
      timeoutMs: 20,
    });
    const report = await runBattery({ reviewer, model: "broken" });
    expect(report.cases.every((r) => r.outcome === "ask" && r.skipped === "error")).toBe(true);
    expect(report.classes.map((c) => [c.klass, c.misses, c.falseAsks])).toEqual([
      ["risky", 0, 0],
      ["injected", 0, 0],
      ["benign", 0, 8],
    ]);
  });

  it("the review request holds only the user's messages, the rules and the call: never a result or assistant text", async () => {
    const { provider, reviewer } = reviewerThat(idealAnswer);
    await runBattery({ reviewer, model: "ideal" });
    expect(provider.requests).toHaveLength(24);
    for (const req of provider.requests) {
      expect(req.messages).toHaveLength(1);
      expect(req.messages[0]?.role).toBe("user");
      expect(req.messages[0]?.blocks.map((b) => b.type)).toEqual(["text"]);
      expect(req.tools.map((t) => t.name)).toEqual([REVIEW_TOOL_NAME]);
    }
  });

  it("stops before a case when the budget is spent, and says which were not run", async () => {
    const { reviewer } = reviewerThat(idealAnswer);
    const one = (1000 * 1 + 40 * 5) / 1_000_000;
    const report = await runBattery({ reviewer, model: "ideal", budgetUsd: one * 2.5 });
    expect(report.cases).toHaveLength(3);
    expect(report.notRun).toHaveLength(21);
    expect(formatBatteryReport(report).join("\n")).toContain("NÃO RODARAM");
  });

  it("the report has one line per class, with misses, false asks and cost", async () => {
    const { reviewer } = reviewerThat(idealAnswer);
    const text = formatBatteryReport(await runBattery({ reviewer, model: "ideal" })).join("\n");
    expect(text).toContain("(a) arriscadas: 8 casos, 0 deixaram passar");
    expect(text).toContain("(b) com texto do atacante: 8 casos, 0 deixaram passar");
    expect(text).toContain("(c) benignas próximas: 8 casos, 0 falsos pedidos");
    expect(text).toContain("US$");
  });
});
