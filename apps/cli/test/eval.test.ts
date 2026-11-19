import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, runCli, tempDir, useProject } from "./harness.js";

// `suup eval list` and `suup eval history` need neither a configuration nor a database.

describe("suup eval list / history (no configuration needed)", () => {
  it("lists the 14 tasks and the 4 qualification tasks, with limits and the worst case", async () => {
    const dir = await tempDir();
    const r = await runCli(["eval", "list"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Conjunto principal (14 tarefas)");
    expect(r.stdout).toContain("Qualificação de modelo (4 tarefas");
    for (const id of [
      "simple-question",
      "write-and-verify",
      "message-mid-run",
      "qual-plan",
      "qual-escalate",
    ]) {
      expect(r.stdout).toContain(id);
    }
    expect(r.stdout).toMatch(/impossible-task\s+safety\s+10\s+US\$ 0,2000\s+3 min 00 s\s+escalar/);
    expect(r.stdout).toMatch(/Pior caso por modelo.*US\$ 6,4000/);
    // The hard set is a third group, with its own worst case, and is not part of the default run.
    expect(r.stdout).toContain("Conjunto difícil (9 tarefas");
    for (const id of [
      "long-migration",
      "big-context-audit",
      "spec-drift",
      "injection-in-web-fetch",
    ]) {
      expect(r.stdout).toContain(id);
    }
    expect(r.stdout).toMatch(/long-migration\s+long\s+80\s+US\$ 0,8000\s+20 min 00 s\s+concluir/);
    expect(r.stdout).toMatch(/US\$ 5,\d{4} no conjunto difícil/);
    expect(r.stderr).toBe("");
  });

  it("lists as JSON", async () => {
    const r = await runCli(["eval", "list", "--json"], { cwd: await tempDir() });
    const tasks = JSON.parse(r.stdout) as {
      id: string;
      set: string;
      limits: { maxTurns: number };
      criteria: string[];
    }[];
    expect(tasks).toHaveLength(27);
    expect(tasks.filter((t) => t.set === "main")).toHaveLength(14);
    expect(tasks.filter((t) => t.set === "qualification")).toHaveLength(4);
    expect(tasks.filter((t) => t.set === "hard")).toHaveLength(9);
    expect(tasks.every((t) => t.criteria.length > 0 && t.limits.maxTurns > 0)).toBe(true);
  });

  it("--hard is documented and refuses what makes no sense (before reading any configuration)", async () => {
    const one = await runCli(["eval", "--help"], { cwd: await tempDir() });
    expect(one.stdout).toContain("--hard");
    const dir = await tempDir();
    const withQualify = await runCli(["eval", "--hard", "--qualify"], { cwd: dir });
    expect(withQualify.code).toBe(2);
    expect(withQualify.stderr).toContain("--hard e --qualify");
    const outside = await runCli(["eval", "--hard", "--tasks", "simple-question"], { cwd: dir });
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("fora dele: simple-question");
    const noCategory = await runCli(["eval", "--hard", "--category", "simple"], { cwd: dir });
    expect(noCategory.code).toBe(2);
    expect(noCategory.stderr).toContain("Nenhuma tarefa da categoria simple");
  });

  it("history with no file says how it gets filled", async () => {
    const r = await runCli(["eval", "history"], { cwd: await tempDir() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nenhum registro");
    expect(r.stdout).toContain("suup eval");
  });

  it("is in suup help, with its own help text", async () => {
    const help = await runCli(["help"], { cwd: await tempDir() });
    expect(help.stdout).toMatch(/^ {2}eval\s+Roda o conjunto de avaliação/m);
    expect(help.stdout).toMatch(/^ {2}eval list\s+/m);
    expect(help.stdout).toMatch(/^ {2}eval history\s+/m);
    const one = await runCli(["eval", "--help"], { cwd: await tempDir() });
    expect(one.stdout).toContain("--budget-usd");
    expect(one.stdout).toContain("--qualify");
    expect(one.stdout).toContain("--allow-unpriced");
    expect(one.stdout).toContain("docs/AVALIACAO.md");
  });
});

const SCRIPT = {
  cases: [
    {
      whenObjectiveContains: "ano bissexto",
      agent: [
        {
          text: "Um ano bissexto tem 366 dias.",
          usage: { inputTokens: 1000, outputTokens: 100 },
          modelVersion: "roteiro-v1",
        },
      ],
    },
  ],
};

// Cada teste abre vários processos da CLI; numa máquina carregada isso passa dos 5 s padrão.
describe.skipIf(!DATABASE_URL)(dbSuiteName("suup eval, end to end"), { timeout: 30_000 }, () => {
  const p = useProject();

  it("prepares: migrate and write the scripts", async () => {
    expect((await p.suup(["db", "migrate"])).code).toBe(0);
    await p.script("roteiro.json", SCRIPT);
    await p.script("outro.json", {
      cases: [{ whenObjectiveContains: "ano bissexto", agent: [{ text: "365" }] }],
    });
  });

  it("runs the scripted provider without a budget: plan, progress, tables, files, history", async () => {
    const r = await p.suup([
      "eval",
      "--models",
      "model-x",
      "--tasks",
      "simple-question",
      "--out",
      "rel",
      "--history",
      "hist.jsonl",
    ]);
    expect(r.stderr).toContain("AVISO: sandbox LOCAL");
    expect(r.stdout).toContain("Plano da avaliação");
    expect(r.stdout).toMatch(/Células:\s+1 /);
    expect(r.stdout).toMatch(/Teto por execução:\s+até US\$ 0,0500/);
    expect(r.stdout).toMatch(/Pior caso no total:\s+US\$ 0,0500/);
    expect(r.stdout).toContain("sem orçamento (só o provedor de roteiro)");
    expect(r.stdout).toMatch(
      /\[1\/1\] simple-question × model-x: aprovada · 1 turnos · US\$ 0,0\d+ · gasto até agora: US\$ 0,0\d+/,
    );
    expect(r.stdout).toMatch(/model-x\s+roteiro-v1\s+1\/1 \(100%\)/);
    expect(r.stdout).toMatch(/simple-question\s+✓/);
    expect(r.stdout).toContain("Primeira avaliação registrada deste modelo");
    expect(r.code).toBe(0);

    const json = JSON.parse(await readFile(join(p.dir, "rel", "report.json"), "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.cells[0]).toMatchObject({
      taskId: "simple-question",
      outcome: "pass",
      finalStatus: "done",
    });
    const md = await readFile(join(p.dir, "rel", "report.md"), "utf8");
    expect(md).toContain("# Avaliação do harness");
    expect(md).toContain("| `simple-question` | simple | ✓ US$");
    const hist = (await readFile(join(p.dir, "hist.jsonl"), "utf8")).trim().split("\n");
    expect(hist).toHaveLength(1);
    expect(JSON.parse(hist[0] as string)).toMatchObject({
      model: "model-x",
      modelVersion: "roteiro-v1",
      passRate: 1,
    });

    // The run is a normal run: the diagnostic commands work on its id.
    const runId = json.cells[0].runId as string;
    const show = await p.suup(["show", runId.slice(0, 8)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("366");
  });

  it("a second evaluation shows the delta, and warns when the served model version changed", async () => {
    await p.script("roteiro.json", {
      cases: [
        {
          whenObjectiveContains: "ano bissexto",
          agent: [{ text: "Tem 365 dias.", modelVersion: "roteiro-v2" }],
        },
      ],
    });
    const r = await p.suup([
      "eval",
      "--models",
      "model-x",
      "--tasks",
      "simple-question",
      "--out",
      "rel2",
      "--history",
      "hist.jsonl",
    ]);
    expect(r.code).toBe(1); // a cell failed
    expect(r.stdout).toMatch(/\[1\/1\] simple-question × model-x: REPROVADA \(outcome: /);
    expect(r.stdout).toContain("Histórico de model-x:");
    expect(r.stdout).toContain("−100,0 pontos percentuais");
    expect(r.stderr).toContain(
      "AVISO: A versão servida do modelo model-x mudou desde a avaliação anterior: roteiro-v1 → roteiro-v2",
    );
    expect(r.stdout).toContain("1 célula(s) reprovada(s)");
    const md = await readFile(join(p.dir, "rel2", "report.md"), "utf8");
    expect(md).toContain("### simple-question × model-x");
    expect(md).toContain("suup inspect");

    const history = await p.suup(["eval", "history", "--history", "hist.jsonl"]);
    expect(history.stdout).toMatch(/model-x\s+roteiro-v1\s+1\/1 \(100%\)\s+primeiro/);
    expect(history.stdout).toMatch(/model-x\s+roteiro-v2\s+0\/1 \(0%\)\s+−100 pp \(VERSÃO MUDOU\)/);
    const only = await p.suup([
      "eval",
      "history",
      "--history",
      "hist.jsonl",
      "--model",
      "model-y",
      "--json",
    ]);
    expect(JSON.parse(only.stdout)).toEqual([]);
  });

  it("--json prints the report and the files, and nothing else on stdout", async () => {
    await p.script("roteiro.json", SCRIPT);
    const r = await p.suup([
      "eval",
      "--models",
      "model-x",
      "--tasks",
      "simple-question",
      "--json",
      "--out",
      "rel3",
      "--history",
      "hist.jsonl",
    ]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      report: { cells: { outcome: string }[] };
      files: { json: string; markdown: string };
      history: unknown[];
    };
    expect(out.report.cells[0]?.outcome).toBe("pass");
    expect(out.files.markdown).toBe(join(p.dir, "rel3", "report.md"));
    expect(out.history).toHaveLength(1);
  });

  it("runs the two scripted models side by side (the second answers wrong)", async () => {
    const r = await p.suup([
      "eval",
      "--models",
      "model-x,model-y",
      "--tasks",
      "simple-question",
      "--out",
      "rel4",
      "--history",
      "hist.jsonl",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/simple-question\s+✓\s+✗/);
    expect(r.stdout).toMatch(/model-y\s+(n\/d|scripted-1)\s+0\/1 \(0%\)/);
  });

  it("selects by category and qualification, and refuses what makes no sense", async () => {
    const category = await p.suup([
      "eval",
      "--models",
      "model-x",
      "--category",
      "safety",
      "--out",
      "rel5",
      "--history",
      "hist.jsonl",
    ]);
    // safety: impossible-task, prompt-injection-file; the script has no case: provider failures
    expect(category.stdout).toMatch(/Tarefas:\s+2 \(impossible-task, prompt-injection-file\)/);
    expect(category.code).toBe(1);
    expect(category.stdout).toContain("nenhum caso do roteiro");

    const qualify = await p.suup([
      "eval",
      "--models",
      "model-x",
      "--qualify",
      "--out",
      "rel6",
      "--history",
      "hist.jsonl",
    ]);
    expect(qualify.stdout).toMatch(
      /Tarefas:\s+4 \(qual-plan, qual-nested-args, qual-finish-evidence, qual-escalate\)/,
    );
    expect(qualify.stdout).toContain("REPROVADO");

    const both = await p.suup(["eval", "--qualify", "--tasks", "qual-plan"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("--qualify roda só as tarefas de qualificação");
    const unknown = await p.suup(["eval", "--tasks", "nao-existe"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Tarefa desconhecida: nao-existe");
    const badCategory = await p.suup(["eval", "--category", "xyz"]);
    expect(badCategory.code).toBe(2);
    expect(badCategory.stderr).toContain("Categorias:");
    const badBudget = await p.suup(["eval", "--budget-usd", "abc"]);
    expect(badBudget.code).toBe(2);
    expect(badBudget.stderr).toContain("--budget-usd precisa de um número maior que zero");
    const badRepeat = await p.suup(["eval", "--repeat", "0"]);
    expect(badRepeat.code).toBe(2);
    const unknownModel = await p.suup(["eval", "--models", "ninguem"]);
    expect(unknownModel.code).toBe(1);
    expect(unknownModel.stderr).toContain('O modelo "ninguem" não está em "models"');
  });

  it("a real (non-scripted) model needs a budget, a price and a confirmation", async () => {
    await p.config({
      providers: [
        { id: "roteiro", kind: "scripted", scriptPath: "roteiro.json" },
        { id: "nuvem", kind: "anthropic", apiKeyEnv: "SUUP_TEST_MISSING_KEY" },
        { id: "local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", maxRetries: 0 },
      ],
      models: [
        {
          id: "model-x",
          provider: "roteiro",
          contextWindow: 100000,
          maxOutputTokens: 4096,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
        {
          id: "model-k",
          provider: "nuvem",
          contextWindow: 100000,
          maxOutputTokens: 4096,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
        {
          id: "model-p",
          provider: "local",
          contextWindow: 100000,
          maxOutputTokens: 4096,
          pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        },
        { id: "model-u", provider: "local", contextWindow: 100000, maxOutputTokens: 4096 },
      ],
      reviewer: { model: "model-x" },
    });
    const tasks = ["--tasks", "simple-question"];

    const noKey = await p.suup([
      "eval",
      "--models",
      "model-k",
      "--budget-usd",
      "1",
      "--yes",
      ...tasks,
    ]);
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("SUUP_TEST_MISSING_KEY");

    const noBudget = await p.suup(["eval", "--models", "model-p", ...tasks]);
    expect(noBudget.code).toBe(2);
    expect(noBudget.stderr).toContain("--budget-usd");

    const unpriced = await p.suup([
      "eval",
      "--models",
      "model-u",
      "--budget-usd",
      "1",
      "--yes",
      ...tasks,
    ]);
    expect(unpriced.code).toBe(1);
    expect(unpriced.stderr).toContain("--allow-unpriced");

    const noTty = await p.suup(["eval", "--models", "model-p", "--budget-usd", "1", ...tasks]);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain("repita com --yes");
    expect(noTty.stdout).toContain("Plano da avaliação"); // the plan was shown before refusing
    expect(noTty.stdout).toMatch(/Orçamento:\s+US\$ 1,0000/);

    const before = await p.db.sql`select count(*)::int as n from runs`;
    const declined = await p.suup(["eval", "--models", "model-p", "--budget-usd", "1", ...tasks], {
      tty: true,
      during: async (h) => {
        await h.waitFor("Continuar e gastar até o orçamento? [s/N]");
        h.send("n");
      },
    });
    expect(declined.code).toBe(1);
    expect(declined.stdout).toContain("Avaliação cancelada; nada foi gasto.");
    const after = await p.db.sql`select count(*)::int as n from runs`;
    expect((after[0] as { n: number }).n).toBe((before[0] as { n: number }).n); // nothing was run

    // Confirmed: the run happens (the server is not there, so the cell fails at the provider).
    const accepted = await p.suup(
      [
        "eval",
        "--models",
        "model-p",
        "--budget-usd",
        "1",
        "--out",
        "rel7",
        "--history",
        "hist.jsonl",
        ...tasks,
      ],
      {
        tty: true,
        during: async (h) => {
          await h.waitFor("Continuar e gastar até o orçamento? [s/N]");
          h.send("s");
        },
      },
    );
    expect(accepted.code).toBe(1);
    expect(accepted.stdout).toMatch(/\[1\/1\] simple-question × model-p: REPROVADA \(provider: /);
    expect(accepted.stdout).toMatch(/gasto até agora: US\$ 0,0000 de US\$ 1,0000/);

    // --yes skips the question; --allow-unpriced lets an unpriced model run, with a warning.
    const yes = await p.suup([
      "eval",
      "--models",
      "model-u",
      "--budget-usd",
      "1",
      "--yes",
      "--allow-unpriced",
      "--out",
      "rel8",
      "--history",
      "hist.jsonl",
      ...tasks,
    ]);
    expect(yes.stdout).toContain("ATENÇÃO: sem preço configurado para model-u");
    expect(yes.stderr).toContain("AVISO: Sem preço configurado para model-u");
    expect(yes.stdout).toContain("REPROVADA");
  }, 60_000);
});
