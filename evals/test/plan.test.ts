import { createRuntime, parseConfig, RuntimeError } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { evalTasks, planEval, qualificationTasks, runEval } from "../src/index.js";

// What the request is checked for before anything runs (no database involved).

const config = parseConfig({
  providers: [
    { id: "script", kind: "scripted", scriptPath: "none.json" },
    { id: "cloud", kind: "anthropic", apiKeyEnv: "SUUP_EVAL_TEST_KEY" },
    { id: "local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" },
  ],
  models: [
    { id: "free", provider: "script", contextWindow: 10_000, maxOutputTokens: 1000 },
    {
      id: "paid",
      provider: "cloud",
      contextWindow: 10_000,
      maxOutputTokens: 1000,
      pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    },
    { id: "unpriced", provider: "local", contextWindow: 10_000, maxOutputTokens: 1000 },
  ],
  sandbox: { kind: "local", root: "workspace" },
});

const runtime = (env: Record<string, string> = { SUUP_EVAL_TEST_KEY: "k" }) =>
  createRuntime(config, { env, baseDir: "/var/tmp" });

const tasks = evalTasks.slice(0, 3);

describe("planEval", () => {
  it("lists the cells (repetition, task, model), the cap of each and the worst case", () => {
    const plan = planEval({
      runtime: runtime(),
      models: ["free", "paid"],
      tasks,
      repeat: 2,
      budgetUsd: 100,
    });
    expect(plan.cells).toHaveLength(12);
    expect(plan.cells.slice(0, 4).map((c) => `${c.taskId}/${c.model}/${c.repetition}`)).toEqual([
      "simple-question/free/1",
      "simple-question/paid/1",
      "write-and-verify/free/1",
      "write-and-verify/paid/1",
    ]);
    const perPass = tasks.reduce((sum, t) => sum + 2 * t.limits.maxCostUsd, 0);
    expect(plan.worstCaseUsd).toBeCloseTo(2 * perPass, 9);
    expect(plan.largestRunCapUsd).toBe(Math.max(...tasks.map((t) => t.limits.maxCostUsd)));
    expect(plan.cellsThatFit).toBe(12);
    expect(plan.costsMoney).toBe(true);
  });

  it("never lets a run's cap go above maxCostPerRunUsd", () => {
    const plan = planEval({
      runtime: runtime(),
      models: ["paid"],
      tasks,
      budgetUsd: 100,
      maxCostPerRunUsd: 0.07,
    });
    expect(plan.cells.map((c) => c.maxCostUsd)).toEqual([0.05, 0.07, 0.07]);
    expect(plan.largestRunCapUsd).toBe(0.07);
  });

  it("says how many cells the budget covers at the caps", () => {
    const plan = planEval({ runtime: runtime(), models: ["paid"], tasks, budgetUsd: 0.4 });
    // 0.05 + 0.30 = 0.35 fits; the 0.30 after it does not.
    expect(plan.cellsThatFit).toBe(2);
  });

  it("asks for no budget when every model is the scripted provider", () => {
    const plan = planEval({ runtime: runtime(), models: ["free"], tasks });
    expect(plan.budgetUsd).toBeNull();
    expect(plan.costsMoney).toBe(false);
    expect(plan.cellsThatFit).toBe(plan.cells.length);
  });

  it("requires a budget as soon as one model is a real one", () => {
    expect(() => planEval({ runtime: runtime(), models: ["free", "paid"], tasks })).toThrow(
      expect.objectContaining({ name: "EvalSetupError", code: "no_budget" }),
    );
  });

  it("refuses a model without pricing unless --allow-unpriced, and says which", () => {
    const attempt = () =>
      planEval({ runtime: runtime(), models: ["paid", "unpriced"], tasks, budgetUsd: 5 });
    expect(attempt).toThrow(expect.objectContaining({ code: "unpriced" }));
    expect(attempt).toThrow(/unpriced.*"pricing".*--allow-unpriced/s);
    const plan = planEval({
      runtime: runtime(),
      models: ["paid", "unpriced"],
      tasks,
      budgetUsd: 5,
      allowUnpriced: true,
    });
    expect(plan.unpricedModels).toEqual(["unpriced"]);
  });

  it("refuses to start when the API key variable of a provider is missing", () => {
    const attempt = () => planEval({ runtime: runtime({}), models: ["paid"], tasks, budgetUsd: 5 });
    expect(attempt).toThrow(expect.objectContaining({ code: "missing_key" }));
    expect(attempt).toThrow(/SUUP_EVAL_TEST_KEY/);
  });

  it("refuses nonsense options and unknown models", () => {
    const base = { runtime: runtime(), models: ["free"], tasks };
    expect(() => planEval({ ...base, repeat: 0 })).toThrow(/repetições/);
    expect(() => planEval({ ...base, models: [] })).toThrow(/Nenhum modelo/);
    expect(() => planEval({ ...base, tasks: [] })).toThrow(/Nenhuma tarefa/);
    expect(() => planEval({ ...base, models: ["free", "free"] })).toThrow(/repetidos/);
    expect(() => planEval({ ...base, budgetUsd: 0 })).toThrow(/orçamento/);
    expect(() => planEval({ ...base, maxCostPerRunUsd: -1 })).toThrow(/teto/);
    expect(() => planEval({ ...base, models: ["nope"] })).toThrow(RuntimeError);
  });

  it("runEval needs a runtime or a configuration", async () => {
    await expect(runEval({ models: ["free"], tasks })).rejects.toThrow(
      /runtime ou de uma configuração/,
    );
  });

  it("the whole suite at the caps stays within what one model may cost", () => {
    const main = evalTasks.reduce((sum, t) => sum + t.limits.maxCostUsd, 0);
    const qualification = qualificationTasks.reduce((sum, t) => sum + t.limits.maxCostUsd, 0);
    expect(main + qualification).toBeLessThan(7.5);
  });
});
