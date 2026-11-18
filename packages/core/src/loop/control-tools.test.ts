import { describe, expect, it } from "vitest";
import { controlToolSpecs, describePlan, validateFinish, validatePlan } from "./control-tools.js";

const step = (
  id: string,
  status: "pending" | "in_progress" | "done" | "dropped",
  note?: string,
) => ({
  id,
  title: `T${id}`,
  status,
  ...(note === undefined ? {} : { note }),
});

describe("control tool specs", () => {
  const specs = controlToolSpecs();

  it("exposes plan, finish and escalate with real descriptions and object schemas", () => {
    expect(specs.map((s) => s.name)).toEqual(["plan", "finish", "escalate"]);
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(300);
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema.$schema).toBeUndefined();
    }
  });

  it("describes the arguments the model must send", () => {
    const plan = specs[0]?.inputSchema as {
      properties: { steps: { items: { required: string[] } } };
    };
    expect(plan.properties.steps.items.required).toEqual(["id", "title", "status"]);
    const finish = specs[1]?.inputSchema as { required?: string[] };
    expect(finish.required).toEqual(["summary"]);
    const escalate = specs[2]?.inputSchema as { required: string[] };
    expect(escalate.required).toEqual(["question"]);
  });
});

describe("validatePlan", () => {
  it("accepts a sound plan and growth", () => {
    expect(
      validatePlan([step("a", "done"), step("b", "in_progress")], [step("a", "pending")]),
    ).toEqual([]);
  });

  it("collects every problem", () => {
    const problems = validatePlan(
      [
        step("a", "in_progress"),
        step("a", "in_progress"),
        { id: "c", title: " ", status: "dropped" },
      ],
      [step("gone", "pending")],
    );
    expect(problems.join("\n")).toMatch(/duplicate step id "a"/);
    expect(problems.join("\n")).toMatch(/empty title/);
    expect(problems.join("\n")).toMatch(/no note/);
    expect(problems.join("\n")).toMatch(/in_progress/);
    expect(problems.join("\n")).toMatch(/"gone".*removed/);
  });

  it("lets an already dropped step go", () => {
    expect(
      validatePlan([step("a", "done")], [step("a", "done"), step("b", "dropped", "n/a")]),
    ).toEqual([]);
  });
});

describe("validateFinish", () => {
  const args = (summary: string, evidence: { criterion: string; evidence: string }[]) => ({
    summary,
    evidence,
  });

  it("passes with matching evidence by text or index", () => {
    expect(
      validateFinish(
        args("ok", [
          { criterion: "A", evidence: "x" },
          { criterion: " 2 ", evidence: "y" },
        ]),
        ["A", "B"],
        [step("a", "done"), step("b", "dropped", "n")],
      ),
    ).toEqual([]);
  });

  it("does not match a criterion by a different number", () => {
    const reasons = validateFinish(args("ok", [{ criterion: "3", evidence: "x" }]), ["A"], []);
    expect(reasons).toHaveLength(1);
  });

  it("describes the plan when it is saved", () => {
    expect(describePlan([step("a", "done"), step("b", "pending")])).toContain("Next: b (Tb)");
    expect(describePlan([step("a", "done")])).toContain("call finish");
  });
});
