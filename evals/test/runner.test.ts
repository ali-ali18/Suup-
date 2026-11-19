import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb, getRun, listMemories } from "@suup/db";
import { finishRun, parseConfig, type RuntimeConfig, reconcileRunEffects } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import {
  type CellResult,
  type EvalProgress,
  type EvalReport,
  evalReportSchema,
  evalTasks,
  isQualified,
  qualificationTasks,
  readHistory,
  recordHistory,
  renderMarkdown,
  runEval,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { tempDir } from "./logs.js";
import { quitter, solver, spender } from "./scripts.js";

const task = (id: string) => {
  const found = [...evalTasks, ...qualificationTasks].find((t) => t.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("the evaluation runner, end to end"), () => {
  const ctx = useIsolatedDb();

  async function project(scripts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const dir = await tempDir("suup-evals-run-");
    const providers = [];
    const models = [];
    for (const [name, script] of Object.entries(scripts)) {
      await writeFile(join(dir, `${name}.json`), JSON.stringify(script));
      providers.push({ id: name, kind: "scripted", scriptPath: `${name}.json` });
      models.push({
        id: `${name}-1`,
        provider: name,
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      });
    }
    const config: RuntimeConfig = parseConfig({
      providers,
      models,
      reviewer: { model: "alpha-1" },
      sandbox: { kind: "local", root: "workspace" },
      worker: { concurrency: 2, leaseRenewMs: 1000, staleAfterMs: 5000 },
      ...extra,
    });
    return { dir, config, env: { DATABASE_URL: ctx.url }, baseDir: dir };
  }

  const evaluate = (
    p: Awaited<ReturnType<typeof project>>,
    options: Omit<Parameters<typeof runEval>[0], "config" | "runtimeOptions">,
  ) =>
    runEval({ config: p.config, runtimeOptions: { env: p.env, baseDir: p.baseDir }, ...options });

  const cell = (report: EvalReport, taskId: string, model: string): CellResult => {
    const found = report.cells.find((c) => c.taskId === taskId && c.model === model);
    if (found === undefined) throw new Error(`no cell ${taskId} x ${model}`);
    return found;
  };

  it("isolates the evaluation from memory: no rules, profile or memory tools reach the model", async () => {
    // What a real user told the system, sitting in the very database the evaluation runs on.
    const { addMemory } = await import("@suup/db");
    await addMemory(ctx.db, {
      layer: "rule",
      text: "REGRA-DO-USUARIO: responda sempre em inglês.",
      createdBy: "user",
    });
    await addMemory(ctx.db, {
      layer: "profile",
      text: "FATO-DO-USUARIO: mora em Recife.",
      createdBy: "user",
    });
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("simple-question")],
      budgetUsd: 10,
    });
    const found = cell(report, "simple-question", "alpha-1");
    expect(found.outcome).toBe("pass");

    const events = await ctx.db.sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from run_events where run_id = ${found.runId as string} order by seq`;
    // No `context_loaded` at all: nothing was loaded from the database.
    expect(events.filter((e) => e.type === "context_loaded")).toEqual([]);

    const first = events.find((e) => e.type === "model_request");
    const request = first?.payload as {
      system: string;
      tools: { name: string }[];
      messages: unknown;
    };
    expect(request.system).not.toContain("REGRA-DO-USUARIO");
    expect(request.system).not.toContain("FATO-DO-USUARIO");
    expect(request.system).not.toContain("Standing rules from the user");
    expect(request.system).not.toContain("What you know about the user");
    expect(request.system).not.toContain("Memory:");
    expect(JSON.stringify(request.messages)).not.toContain("USUARIO");
    const tools = request.tools.map((t) => t.name).sort();
    for (const memoryTool of ["remember", "recall", "forget", "search_conversations"]) {
      expect(tools).not.toContain(memoryTool);
    }
    // Exactly what a bot had before memory existed: the control tools and the seven built-ins.
    expect(tools).toEqual(
      [
        "plan",
        "finish",
        "escalate",
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "search_files",
        "web_fetch",
      ].sort(),
    );

    // Isolated at the end too: the run is marked, and no journal entry is written for it, not by
    // the end-of-run effects and not later by the reconciliation any worker runs at its start.
    const runId = found.runId as string;
    expect((await getRun(ctx.db, runId))?.isolated).toBe(true);
    await finishRun(ctx.db, runId);
    expect(await reconcileRunEffects(ctx.db)).not.toContain(runId);
    const journal = await listMemories(ctx.db, {
      layer: "journal",
      includeArchived: true,
      limit: 200,
    });
    expect(journal.filter((m) => m.sourceRunId === runId)).toEqual([]);
  });

  it("runs a 2 task x 2 model matrix: metrics, failure origins, reports and history", async () => {
    const p = await project({
      alpha: solver("alpha-2026-11"),
      beta: quitter("beta-2026-11"),
    });
    const events: EvalProgress[] = [];
    const report = await evaluate(p, {
      models: ["alpha-1", "beta-1"],
      tasks: [task("simple-question"), task("write-and-verify")],
      budgetUsd: 10,
      onProgress: (e) => events.push(e),
    });

    // The matrix.
    expect(report.cells.map((c) => `${c.taskId}/${c.model}/${c.outcome}`)).toEqual([
      "simple-question/alpha-1/pass",
      "simple-question/beta-1/fail",
      "write-and-verify/alpha-1/pass",
      "write-and-verify/beta-1/fail",
    ]);
    const good = cell(report, "write-and-verify", "alpha-1");
    expect(good).toMatchObject({
      finalStatus: "done",
      failureOrigin: null,
      turns: 5,
      reviews: 1,
      reviewerRejects: 0,
      invalidArgs: 0,
      toolErrors: 0,
      nudges: 0,
      modelVersions: ["alpha-2026-11"],
      expectedStatus: "done",
    });
    expect(good.checks.every((c) => c.pass)).toBe(true);
    expect(good.costUsd).toBeGreaterThan(0);
    expect(good.inputTokens).toBe(10_000 + 2000); // 5 agent turns + the review
    expect(good.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(good.lastRequestSeq).toBeGreaterThan(0);

    // A wrong answer: the run is fine, the result is not.
    const wrong = cell(report, "simple-question", "beta-1");
    expect(wrong.failureOrigin).toBe("outcome");
    expect(wrong.failureDetail).toContain("366");
    expect(wrong.checks.filter((c) => !c.pass).map((c) => c.name)).toContain("a resposta diz 366");

    // Stopping early: plain text with an open plan, until the harness gives up on the model.
    const early = cell(report, "write-and-verify", "beta-1");
    expect(early.finalStatus).toBe("failed");
    expect(early.failureOrigin).toBe("model");
    expect(early.failureDetail).toMatch(/consecutive turns without any tool call/);
    expect(early.nudges).toBeGreaterThanOrEqual(2);
    expect(early.modelVersions).toEqual(["beta-2026-11"]);

    // The workspace of a cell is where its bot worked.
    const written = await readFile(
      join(p.dir, "workspace", "bots", good.botId as string, "saudacao.txt"),
      "utf8",
    );
    expect(written).toBe("Olá, mundo!\nSuup está pronto.\n");

    // The aggregates.
    const [alpha, beta] = report.summary;
    expect(alpha).toMatchObject({
      model: "alpha-1",
      executed: 2,
      passed: 2,
      passRate: 1,
      completionRate: 1,
      invalidArgRate: 0,
      reviewerRejectionRate: 0,
      turnsPerRun: 3, // (1 + 5) / 2
      modelVersions: ["alpha-2026-11"],
      failureOrigins: {},
      qualification: null,
    });
    expect(alpha?.byCategory).toMatchObject({
      simple: { executed: 1, passed: 1, passRate: 1 },
      files: { executed: 1, passed: 1, passRate: 1 },
    });
    expect(alpha?.costPerRun).toBeGreaterThan(0);
    expect(beta).toMatchObject({
      model: "beta-1",
      passRate: 0,
      completionRate: 0.5, // one run ended `done` (wrongly), one failed
      reviewerRejectionRate: null,
      failureOrigins: { outcome: 1, model: 1 },
    });
    expect(beta?.turnsPerRun).toBeGreaterThan(1);

    // Spending adds up and was reported after every run.
    const total = report.cells.reduce((sum, c) => sum + c.costUsd, 0);
    expect(report.spentUsd).toBeCloseTo(total, 9);
    const ends = events.filter((e) => e.type === "cell_end");
    expect(ends).toHaveLength(4);
    const spentAfter = ends.map((e) => (e.type === "cell_end" ? e.spentUsd : 0));
    expect(spentAfter).toEqual([...spentAfter].sort((a, b) => a - b));
    expect(spentAfter.at(-1)).toBeCloseTo(total, 9);

    // The JSON report is schema-valid and survives a round trip.
    expect(evalReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);

    // The bots left behind are archived, and the runs stay.
    const bots = await ctx.db.sql`select count(*)::int as n from bots where archived_at is null`;
    expect((bots[0] as { n: number }).n).toBe(0);

    // The history: first entry has nothing to compare with; the second does.
    const history = join(p.dir, "history.jsonl");
    const first = await recordHistory(report, history);
    expect(first.entries.map((e) => e.model)).toEqual(["alpha-1", "beta-1"]);
    expect(first.notes[0]?.lines[0]).toContain("Primeira avaliação");
    expect(first.entries[0]).toMatchObject({ modelVersion: "alpha-2026-11", passRate: 1 });

    // Same code, but the "provider" now serves another version and answers worse.
    await writeFile(
      join(p.dir, "alpha.json"),
      JSON.stringify(solver("alpha-2026-12", { bissextile: "Tem 365 dias." })),
    );
    const again = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("simple-question"), task("write-and-verify")],
      budgetUsd: 10,
    });
    expect(cell(again, "simple-question", "alpha-1").outcome).toBe("fail");
    const second = await recordHistory(again, history);
    const note = second.notes[0];
    expect(note?.lines.join("\n")).toContain("100,0%");
    expect(note?.lines.join("\n")).toContain("50,0%");
    expect(note?.lines.join("\n")).toContain("−50,0 pontos percentuais");
    expect(note?.warning).toContain("alpha-2026-11 → alpha-2026-12");
    expect(await readHistory(history)).toHaveLength(3);

    // The Markdown report: matrix, failures, the commands to run next.
    const markdown = renderMarkdown(report, second.notes);
    expect(markdown).toContain("| Tarefa | Categoria | alpha-1 | beta-1 |");
    expect(markdown).toMatch(/\| `simple-question` \| simple \| ✓ US\$ [\d,]+ \| ✗ US\$ [\d,]+ \|/);
    expect(markdown).toMatch(/\| `write-and-verify` \| files \| ✓ US\$/);
    expect(markdown).toContain("## Falhas");
    expect(markdown).toContain("### write-and-verify × beta-1");
    expect(markdown).toContain(`suup show ${(early.runId as string).slice(0, 8)}`);
    expect(markdown).toContain(`suup replay ${(early.runId as string).slice(0, 8)}`);
    expect(markdown).toContain(`--seq ${early.lastRequestSeq}`);
    expect(markdown).toContain("- Origem: `model`");
    expect(markdown).toContain("- Origem: `outcome`");
    expect(markdown).toContain("A versão servida do modelo alpha-1 mudou");
    expect(markdown).toContain("## Origem das falhas");
  });

  it("runs the same results with concurrency 2", async () => {
    const p = await project({ alpha: solver("alpha-2026-11"), beta: quitter("beta-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1", "beta-1"],
      tasks: [task("simple-question"), task("write-and-verify")],
      budgetUsd: 10,
      concurrency: 2,
    });
    expect(report.concurrency).toBe(2);
    expect(report.cells.map((c) => c.outcome)).toEqual(["pass", "fail", "pass", "fail"]);
    expect(report.cells.map((c) => `${c.taskId}/${c.model}`)).toEqual([
      "simple-question/alpha-1",
      "simple-question/beta-1",
      "write-and-verify/alpha-1",
      "write-and-verify/beta-1",
    ]);
  });

  it("repeats every cell and reports each repetition", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("simple-question")],
      repeat: 3,
      budgetUsd: 10,
    });
    expect(report.cells.map((c) => c.repetition)).toEqual([1, 2, 3]);
    expect(new Set(report.cells.map((c) => c.runId)).size).toBe(3);
    expect(report.summary[0]).toMatchObject({ executed: 3, passed: 3 });
    expect(renderMarkdown(report)).toMatch(/✓ 3\/3/);
  });

  it("stops and marks the remaining cells skipped_budget when the budget cannot cover the next run", async () => {
    const p = await project({ alpha: solver("alpha-2026-11"), beta: quitter("beta-2026-11") });
    const before = await ctx.db.sql`select count(*)::int as n from runs`;
    const events: EvalProgress[] = [];
    // simple-question may cost up to 0.05 and write-and-verify up to 0.30, each at its cap.
    // 0.1 pays for the two simple-question runs (0.05 + 0.05 = 0.10 at the cap, ~0.02 really)
    // and then cannot pay the 0.30 cap of the next one.
    const report = await evaluate(p, {
      models: ["alpha-1", "beta-1"],
      tasks: [task("simple-question"), task("write-and-verify")],
      budgetUsd: 0.1,
      onProgress: (e) => events.push(e),
    });
    expect(report.cells.map((c) => `${c.taskId}/${c.model}/${c.outcome}`)).toEqual([
      "simple-question/alpha-1/pass",
      "simple-question/beta-1/fail",
      "write-and-verify/alpha-1/skipped_budget",
      "write-and-verify/beta-1/skipped_budget",
    ]);
    expect(report.spentUsd).toBeLessThanOrEqual(0.1);
    const skipped = cell(report, "write-and-verify", "alpha-1");
    expect(skipped).toMatchObject({ runId: null, turns: 0, costUsd: 0, finalStatus: null });
    expect(report.warnings.join("\n")).toMatch(/Orçamento esgotado.*2 célula\(s\) puladas/);
    expect(events.filter((e) => e.type === "cell_skipped")).toHaveLength(2);
    // Skipped cells are not failures: the rate is over what ran.
    expect(report.summary[0]).toMatchObject({ executed: 1, skipped: 1, passRate: 1 });
    // Nothing was created for the skipped cells: only the two runs that ran.
    const after = await ctx.db.sql`select count(*)::int as n from runs`;
    expect((after[0] as { n: number }).n - (before[0] as { n: number }).n).toBe(2);
    expect(renderMarkdown(report)).toMatch(/\| `write-and-verify` \| files \| skip \| skip \|/);
    expect(evalReportSchema.parse(JSON.parse(JSON.stringify(report)))).toBeTruthy();
    // No entry is written for a model that ran nothing.
    const entries = await recordHistory(report, join(p.dir, "h.jsonl"));
    expect(entries.entries).toHaveLength(2);
  });

  it("counts runs in flight at their cap: skips what could not be afforded, waits when it may fit", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    // One write-and-verify at its cap is 0.30. A run really costs about 0.054.
    // 0.34 pays for the first at its cap, and then 0.054 + 0.30 does not fit: the second is skipped.
    const tight = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("write-and-verify")],
      repeat: 2,
      budgetUsd: 0.34,
      concurrency: 2,
    });
    expect(tight.cells.map((c) => c.outcome)).toEqual(["pass", "skipped_budget"]);
    // 0.4 cannot start both at once (0.60 at the caps), but once the first ends the second fits.
    const loose = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("write-and-verify")],
      repeat: 2,
      budgetUsd: 0.4,
      concurrency: 2,
    });
    expect(loose.cells.map((c) => c.outcome)).toEqual(["pass", "pass"]);
    expect(loose.spentUsd).toBeLessThanOrEqual(0.4);
  });

  it("caps each run with maxCostPerRunUsd: a run that spends past it ends with origin limit", async () => {
    const p = await project({ alpha: solver("alpha-2026-11"), gamma: spender("gamma-1") });
    const report = await evaluate(p, {
      models: ["gamma-1"],
      tasks: [task("write-and-verify")],
      budgetUsd: 10,
      maxCostPerRunUsd: 0.02,
    });
    const spent = cell(report, "write-and-verify", "gamma-1");
    expect(spent).toMatchObject({ finalStatus: "failed", failureOrigin: "limit", turns: 1 });
    expect(spent.failureDetail).toMatch(/cost limit reached/);
    expect(report.maxCostPerRunUsd).toBe(0.02);
    // The cap is on the bot: 0.02 even though the task allows 0.30.
    const bots = await ctx.db.sql`select limits from bots where id = ${spent.botId as string}`;
    expect((bots[0] as { limits: { maxCostUsd: number } }).limits.maxCostUsd).toBe(0.02);
  });

  it("injects the scripted answer after the bot escalates, and the run reaches done following it", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("ambiguous-decision")],
      budgetUsd: 10,
    });
    const result = cell(report, "ambiguous-decision", "alpha-1");
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.outcome).toBe("pass");
    expect(result.finalStatus).toBe("done");
    const total = await readFile(
      join(p.dir, "workspace", "bots", result.botId as string, "total.txt"),
      "utf8",
    );
    expect(total).toBe("1741.15\n");
  });

  it("posts a user message after the first tool result, and the log shows when the bot got it", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("message-mid-run")],
      budgetUsd: 10,
    });
    const result = cell(report, "message-mid-run", "alpha-1");
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.outcome).toBe("pass");
    const db = createDb(ctx.url);
    try {
      const rows = await db.sql`
        select seq, type from run_events where run_id = ${result.runId as string} order by seq`;
      const types = rows.map((r) => `${r.type}`);
      const firstWork = rows.findIndex((r) => r.type === "tool_call");
      expect(types).toContain("user_message");
      expect(types.indexOf("user_message")).toBeGreaterThan(firstWork);
    } finally {
      await db.close();
    }
  });

  it("passes a task whose right outcome is to escalate: the run ends waiting for the user", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("impossible-task")],
      budgetUsd: 10,
    });
    const result = cell(report, "impossible-task", "alpha-1");
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result).toMatchObject({
      outcome: "pass",
      finalStatus: "waiting_user",
      expectedStatus: "waiting_user",
    });
  });

  it("stops launching runs when interrupted and reports the rest as skipped_interrupted", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const controller = new AbortController();
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [task("simple-question"), task("write-and-verify"), task("impossible-task")],
      budgetUsd: 10,
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type === "cell_end") controller.abort();
      },
    });
    expect(report.cells.map((c) => c.outcome)).toEqual([
      "pass",
      "skipped_interrupted",
      "skipped_interrupted",
    ]);
    expect(report.warnings.join(" ")).toContain("Avaliação interrompida");
    expect(report.summary[0]).toMatchObject({ executed: 1, skipped: 2 });
  });

  it("a task whose setup or verifier breaks is a failed cell of origin eval, not a crash", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const base = task("simple-question");
    const brokenSetup = {
      ...base,
      id: "broken-setup",
      async setup() {
        throw new Error("disco cheio");
      },
    };
    const brokenVerify = {
      ...base,
      id: "broken-verify",
      async verify(): Promise<never> {
        throw new Error("o verificador quebrou");
      },
    };
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [brokenSetup, brokenVerify],
      budgetUsd: 10,
    });
    const [a, b] = report.cells;
    expect(a).toMatchObject({ outcome: "fail", failureOrigin: "eval", runId: null });
    expect(a?.failureDetail).toContain("disco cheio");
    expect(b).toMatchObject({ outcome: "fail", failureOrigin: "eval", finalStatus: "done" });
    expect(b?.failureDetail).toContain("o verificador quebrou");
    expect(b?.checks[0]?.name).toBe("o verificador terminou sem erro");
  });

  it("gives up on a run that does not end in time: the cell fails with origin eval and the run is closed", async () => {
    const stuck = {
      cases: [
        {
          whenObjectiveContains: "ano bissexto",
          agent: [{ text: "demorou demais", delayMs: 30_000 }],
        },
      ],
    };
    const p = await project({ alpha: stuck });
    const impatient = {
      ...task("simple-question"),
      limits: { maxTurns: 4, maxCostUsd: 0.05, maxDurationMs: 100 },
    };
    const started = Date.now();
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: [impatient],
      budgetUsd: 10,
      deadlineGraceMs: 400,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const result = cell(report, "simple-question", "alpha-1");
    expect(result).toMatchObject({ outcome: "fail", failureOrigin: "eval", finalStatus: "failed" });
    expect(result.failureDetail).toContain("tempo limite do avaliador");
    const rows = await ctx.db
      .sql`select status, failure_origin from runs where id = ${result.runId as string}`;
    expect(rows[0]).toMatchObject({ status: "failed", failure_origin: "limit" });
  });

  it("runs the qualification tasks of a model that does none of it: reproved, with a reason per task", async () => {
    const p = await project({ alpha: solver("alpha-2026-11") });
    const report = await evaluate(p, {
      models: ["alpha-1"],
      tasks: qualificationTasks,
      budgetUsd: 10,
    });
    // This script has no case for them: the provider fails every call, a provider failure.
    expect(report.cells.every((c) => c.outcome === "fail")).toBe(true);
    expect(new Set(report.cells.map((c) => c.failureOrigin))).toEqual(new Set(["provider"]));
    expect(report.cells[0]?.failureDetail).toContain("nenhum caso do roteiro corresponde");
    const summary = report.summary[0];
    expect(summary?.qualification).toEqual({ executed: 4, passed: 0, required: 4 });
    expect(summary && isQualified(summary)).toBe(false);
    expect(renderMarkdown(report)).toContain("REPROVADO");
  });
});
