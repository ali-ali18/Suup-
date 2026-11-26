import { describe, expect, it } from "vitest";
import { FakeProvider, type FakeStep } from "../testing/fake-provider.js";
import type { JudgedKind } from "../tool.js";
import { resolveReview, SCOPE_FOR_JUDGED } from "./decide.js";
import { createToolGate, type GateCall } from "./gate.js";
import { createModelReviewer, REVIEW_TOOL_NAME } from "./model-reviewer.js";
import type { WrittenRule } from "./written-rules.js";

const executor = {} as GateCall["executor"];
const ASK_RULE: WrittenRule = { id: "w-ask", kind: "ask", text: "gastar dinheiro", botId: null };
const NEVER_RULE: WrittenRule = { id: "w-never", kind: "never", text: "apagar notas", botId: null };

const reply = (extra: Record<string, unknown>): FakeStep => ({
  blocks: [
    {
      type: "tool_call",
      id: "r1",
      name: REVIEW_TOOL_NAME,
      args: { decision: "run", ruleId: null, reason: "Motivo.", ...extra },
    },
  ],
  usage: { inputTokens: 100, outputTokens: 20 },
});

function gate(step: FakeStep, judged: JudgedKind | undefined, overrides = {}) {
  const provider = new FakeProvider([step]);
  const g = createToolGate({
    tools: {
      assess: () => ({
        level: "external_irreversible",
        ...(judged === undefined ? {} : { judged }),
        args: { command: "ls" },
        summary: "Shell: ls",
        toolDescription: "Runs a command.",
        secrets: [],
      }),
    },
    rules: { rulesFor: async () => [] },
    written: { writtenRulesFor: async () => [ASK_RULE, NEVER_RULE] },
    modelReviewer: createModelReviewer({
      provider,
      model: { id: "m", maxOutputTokens: 1000 },
    }),
    levelOverrides: overrides,
    now: () => new Date(0),
  });
  return {
    provider,
    check: () =>
      g.check({
        runId: "r",
        callId: "c1",
        botId: "bot-1",
        name: "shell",
        args: { command: "ls" },
        executor,
        userMessages: ["Liste os arquivos."],
      }),
  };
}

describe("resolveReview: judged calls", () => {
  const base = { decision: "run" as const, ruleId: null, reason: "x" };
  it("runs only with exactly the scope of its kind", () => {
    for (const kind of ["local_shell", "unseen_web_page"] as const) {
      const ok = resolveReview(
        { ...base, scope: SCOPE_FOR_JUDGED[kind] as never },
        "external_irreversible",
        [],
        kind,
      );
      expect(ok.outcome).toBe("allow");
      for (const scope of [
        undefined,
        "other",
        "inside_bot_folder_reversible",
        "public_page_no_user_data",
      ] as const) {
        if (scope === SCOPE_FOR_JUDGED[kind]) continue;
        expect(
          resolveReview(
            { ...base, ...(scope === undefined ? {} : { scope }) },
            "external_irreversible",
            [],
            kind,
          ).outcome,
        ).toBe("ask");
      }
    }
  });
  it("a call that is not judged still needs an allow rule, whatever scope the model gives", () => {
    expect(
      resolveReview({ ...base, scope: "inside_bot_folder_reversible" }, "external_irreversible", [])
        .outcome,
    ).toBe("ask");
  });
  it("citing an ask or never rule still asks, and a failure asks", () => {
    expect(
      resolveReview(
        { ...base, ruleId: "w-ask", scope: "inside_bot_folder_reversible" },
        "external_irreversible",
        [ASK_RULE],
        "local_shell",
      ).outcome,
    ).toBe("ask");
    expect(
      resolveReview(
        { ...base, failure: "error", scope: "inside_bot_folder_reversible" },
        "external_irreversible",
        [],
        "local_shell",
      ).outcome,
    ).toBe("ask");
  });
});

describe("gate: judged calls", () => {
  it("a local shell with the right scope runs and the review records scope and reversible", async () => {
    const { check } = gate(
      reply({ scope: "inside_bot_folder_reversible", reversible: true }),
      "local_shell",
    );
    const v = await check();
    expect(v).toMatchObject({ outcome: "allow", source: "reviewer" });
    expect(v?.review).toMatchObject({
      scope: "inside_bot_folder_reversible",
      reversible: true,
      outcome: "allow",
    });
  });
  it("the scope of the other kind, or none, asks", async () => {
    expect(
      (await gate(reply({ scope: "public_page_no_user_data" }), "local_shell").check())?.outcome,
    ).toBe("ask");
    expect((await gate(reply({}), "local_shell").check())?.outcome).toBe("ask");
    expect((await gate(reply({ scope: "bogus" }), "local_shell").check())?.outcome).toBe("ask");
  });
  it("a call the tool did not declare as judged never runs on the model's word", async () => {
    const { check } = gate(
      reply({ scope: "inside_bot_folder_reversible", reversible: true }),
      undefined,
    );
    expect((await check())?.outcome).toBe("ask");
  });
  it("a level the user fixed for the tool is not settled by the model", async () => {
    const { check } = gate(
      reply({ scope: "inside_bot_folder_reversible", reversible: true }),
      "local_shell",
      { shell: "external_irreversible" },
    );
    expect((await check())?.outcome).toBe("ask");
  });
  it("the prompt names the judged kind, and a plain call says no", async () => {
    const a = gate(reply({ scope: "other" }), "unseen_web_page");
    await a.check();
    const text = a.provider.requests[0]?.messages[0]?.blocks[0];
    expect(text?.type === "text" && text.text).toContain("judged call: unseen_web_page");
  });
});
