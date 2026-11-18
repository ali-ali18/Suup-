import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_HISTORY_FILE,
  EVAL_CATEGORIES,
  type EvalReport,
  EvalSetupError,
  type EvalTask,
  evalTasks,
  type HistoryEntry,
  hardTasks,
  isQualified,
  isSkipped,
  planEval,
  qualificationTasks,
  readHistory,
  recordHistory,
  renderMarkdown,
  runEval,
  stamp,
  taskSetOf,
} from "@suup/evals";
import { flag, str } from "../args.js";
import { type CommandSpec, type Ctx, warnIfLocalSandbox } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, formatDuration, formatInt, formatUsd } from "../format.js";
import { renderTable } from "../table.js";

const NAME = "eval";

const SET_NAME: Record<string, string> = {
  main: "principal",
  qualification: "qualificação",
  hard: "difícil",
  mixed: "misto",
};

const pct = (value: number | null): string =>
  value === null
    ? "n/d"
    : `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const num = (value: number | null): string =>
  value === null ? "n/d" : value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** A positive number with a dot or a comma as the decimal separator (`10`, `0.5`, `0,5`). */
function positiveNumber(ctx: Ctx, name: string, command: string): number | undefined {
  const raw = str(ctx.args, name);
  if (raw === undefined) return undefined;
  const value = /^\d+([.,]\d+)?$/.test(raw) ? Number(raw.replace(",", ".")) : Number.NaN;
  if (!(value > 0)) {
    throw new UsageError(
      `--${name} precisa de um número maior que zero, em dólares (recebido ${JSON.stringify(raw)}).`,
      command,
    );
  }
  return value;
}

function positiveInteger(ctx: Ctx, name: string, command: string): number | undefined {
  const raw = str(ctx.args, name);
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UsageError(
      `--${name} precisa de um número inteiro positivo (recebido ${JSON.stringify(raw)}).`,
      command,
    );
  }
  return Number(raw);
}

const csv = (raw: string | undefined): string[] | undefined =>
  raw === undefined
    ? undefined
    : raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");

function selectTasks(ctx: Ctx): EvalTask[] {
  const ids = csv(str(ctx.args, "tasks"));
  const category = str(ctx.args, "category");
  const qualify = flag(ctx.args, "qualify");
  const hard = flag(ctx.args, "hard");
  if (hard && qualify) {
    throw new UsageError(
      "--hard e --qualify são conjuntos diferentes; escolha um (ou passe ids de tarefas com --tasks).",
      NAME,
    );
  }
  if (qualify && (ids !== undefined || category !== undefined)) {
    throw new UsageError(
      "--qualify roda só as tarefas de qualificação; não combine com --tasks nem --category (para escolher tarefas de qualificação, passe os ids com --tasks).",
      NAME,
    );
  }
  if (ids !== undefined && category !== undefined) {
    throw new UsageError("Use --tasks ou --category, não os dois.", NAME);
  }
  if (qualify) return [...qualificationTasks];
  if (ids !== undefined) {
    const all = [...evalTasks, ...qualificationTasks, ...hardTasks];
    const unknown = ids.filter((id) => !all.some((t) => t.id === id));
    if (unknown.length > 0) {
      throw new UsageError(
        `Tarefa desconhecida: ${unknown.join(", ")}. Veja as existentes com: suup eval list`,
        NAME,
      );
    }
    if (hard) {
      const outside = ids.filter((id) => !hardTasks.some((t) => t.id === id));
      if (outside.length > 0) {
        throw new UsageError(
          `Com --hard, só valem tarefas do conjunto difícil; fora dele: ${outside.join(", ")}. Veja: suup eval list`,
          NAME,
        );
      }
    }
    return [...new Set(ids)].map((id) => all.find((t) => t.id === id) as EvalTask);
  }
  if (category !== undefined) {
    if (!(EVAL_CATEGORIES as readonly string[]).includes(category)) {
      throw new UsageError(
        `Categoria desconhecida: ${JSON.stringify(category)}. Categorias: ${EVAL_CATEGORIES.join(", ")}.`,
        NAME,
      );
    }
    const pool = hard ? hardTasks : evalTasks;
    const picked = pool.filter((t) => t.category === category);
    if (picked.length === 0) {
      throw new UsageError(
        `Nenhuma tarefa da categoria ${category} no conjunto ${hard ? "difícil (--hard)" : "principal"}. Veja: suup eval list`,
        NAME,
      );
    }
    return picked;
  }
  if (hard) return [...hardTasks];
  return [...evalTasks];
}

async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  const rl = createInterface({ input: ctx.io.stdin, terminal: false });
  try {
    ctx.out.raw(question);
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.once("line", resolveAnswer);
      rl.once("close", () => resolveAnswer(""));
    });
    return /^(s|sim|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const evalCommand: CommandSpec = {
  name: NAME,
  summary:
    "Roda o conjunto de avaliação em matriz (tarefas × modelos) e gera os relatórios; custa dinheiro com modelos reais",
  options: {
    models: {
      type: "string",
      value: "a,b",
      help: 'Modelos de "models" na configuração, separados por vírgula (padrão: todos)',
    },
    tasks: { type: "string", value: "id1,id2", help: "Só estas tarefas (veja suup eval list)" },
    category: {
      type: "string",
      value: "categoria",
      help: `Só as tarefas desta categoria (${EVAL_CATEGORIES.join(", ")})`,
    },
    qualify: {
      type: "boolean",
      help: "Roda o teste de qualificação de modelo (4 tarefas baratas), em vez do conjunto principal",
    },
    hard: {
      type: "boolean",
      help: "Roda o conjunto difícil (tarefas longas, de 25 a 60 turnos), em vez do principal; combine com --category ou --tasks para escolher dentro dele",
    },
    repeat: { type: "string", value: "N", help: "Repete cada célula N vezes (padrão 1)" },
    "budget-usd": {
      type: "string",
      value: "N",
      help: "Orçamento máximo, em dólares. Obrigatório, exceto se todos os modelos forem o provedor de roteiro",
    },
    "max-cost-per-run": {
      type: "string",
      value: "N",
      help: "Nenhuma execução pode custar mais que isto, em dólares (limita o teto de cada tarefa)",
    },
    concurrency: { type: "string", value: "N", help: "Execuções ao mesmo tempo (padrão 1)" },
    out: {
      type: "string",
      value: "pasta",
      help: "Pasta dos relatórios (padrão .suup/evals/<data e hora>)",
    },
    history: {
      type: "string",
      value: "arquivo",
      help: `Arquivo do histórico (padrão ${DEFAULT_HISTORY_FILE})`,
    },
    "allow-unpriced": {
      type: "boolean",
      help: "Deixa rodar modelos sem preço na configuração (o custo não será medido nem limitado)",
    },
    yes: { type: "boolean", help: "Não pede confirmação antes de gastar" },
  },
  positionals: { names: [] },
  notes: [
    "Cada célula (tarefa × modelo × repetição) roda com um bot novo, numa pasta de trabalho nova, e é verificada pelo resultado (arquivos, códigos de saída, o log de eventos).",
    "O orçamento é protegido: antes de cada execução, o gasto somado mais o teto dela não pode passar de --budget-usd; senão as células restantes são puladas.",
    "Relatórios: report.json e report.md na pasta de saída; o histórico (uma linha por modelo) vai para .suup/evals/history.jsonl.",
    "Mais detalhes: docs/AVALIACAO.md",
    "  suup eval list                                              as tarefas",
    "  suup eval --models model-x --budget-usd 3 --category code   uma categoria",
    "  suup eval --models model-x --qualify --budget-usd 1         qualificação de um modelo",
    "  suup eval --models model-x --hard --budget-usd 6            o conjunto difícil (fora da execução padrão)",
  ],
  async run(ctx) {
    const { out } = ctx;
    const tasks = selectTasks(ctx);
    const repeat = positiveInteger(ctx, "repeat", NAME);
    const concurrency = positiveInteger(ctx, "concurrency", NAME);
    const budgetUsd = positiveNumber(ctx, "budget-usd", NAME);
    const maxCostPerRunUsd = positiveNumber(ctx, "max-cost-per-run", NAME);

    const runtime = ctx.runtime();
    const models = csv(str(ctx.args, "models")) ?? runtime.config.models.map((m) => m.id);
    const options = {
      runtime,
      models,
      tasks,
      ...(repeat === undefined ? {} : { repeat }),
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      ...(maxCostPerRunUsd === undefined ? {} : { maxCostPerRunUsd }),
      ...(concurrency === undefined ? {} : { concurrency }),
      allowUnpriced: flag(ctx.args, "allow-unpriced"),
    };

    let plan: ReturnType<typeof planEval>;
    try {
      plan = planEval(options);
    } catch (error) {
      if (error instanceof EvalSetupError) {
        if (error.code === "no_budget" || error.code === "bad_options") {
          throw new UsageError(error.message, NAME);
        }
        throw new CommandError(error.message);
      }
      throw error;
    }

    // The plan, before any money is spent.
    const fmtBudget =
      plan.budgetUsd === null
        ? "sem orçamento (só o provedor de roteiro)"
        : formatUsd(plan.budgetUsd);
    out.lines([
      "Plano da avaliação",
      `  Modelos:               ${plan.models.map((m) => m.id).join(", ")}`,
      `  Conjunto:              ${SET_NAME[taskSetOf(plan.tasks.map((t) => t.id))] ?? "misto"}${taskSetOf(plan.tasks.map((t) => t.id)) === "hard" ? " (não é comparável com o histórico do conjunto principal)" : ""}`,
      `  Tarefas:               ${plan.tasks.length} (${plan.tasks.map((t) => t.id).join(", ")})`,
      `  Repetições:            ${plan.repeat}`,
      `  Células:               ${formatInt(plan.cells.length)} (tarefas × modelos × repetições)`,
      `  Teto por execução:     até ${formatUsd(plan.largestRunCapUsd)} (o limite da tarefa, ou --max-cost-per-run se for menor)`,
      `  Pior caso no total:    ${formatUsd(plan.worstCaseUsd)} (todas as execuções gastando até o teto)`,
      `  Orçamento:             ${fmtBudget}`,
    ]);
    if (plan.budgetUsd !== null && plan.cellsThatFit < plan.cells.length) {
      out.line(
        `  ATENÇÃO: o orçamento cobre só ${plan.cellsThatFit} das ${plan.cells.length} células no pior caso; o resto será pulado (skipped_budget) se os gastos chegarem perto do teto.`,
      );
    }
    if (plan.unpricedModels.length > 0) {
      out.line(
        `  ATENÇÃO: sem preço configurado para ${plan.unpricedModels.join(", ")}: o custo não será medido nem limitado.`,
      );
    }
    warnIfLocalSandbox(ctx);

    if (plan.costsMoney && !flag(ctx.args, "yes")) {
      if (ctx.io.stdin.isTTY !== true) {
        throw new CommandError(
          "Esta avaliação gasta dinheiro e não há um terminal para confirmar. Confira o plano acima e repita com --yes.",
        );
      }
      if (!(await confirm(ctx, "Continuar e gastar até o orçamento? [s/N] "))) {
        out.line("Avaliação cancelada; nada foi gasto.");
        return EXIT_FAILED;
      }
    }

    const interrupt = new AbortController();
    const unsubscribe = ctx.io.onInterrupt(() => {
      if (interrupt.signal.aborted) return;
      out.line("");
      out.line(
        "Ctrl+C: nenhuma execução nova vai começar; aguardando as que estão em andamento terminarem (cada uma tem seus limites).",
      );
      interrupt.abort();
    });

    let report: EvalReport;
    try {
      report = await runEval({
        ...options,
        signal: interrupt.signal,
        onProgress(event) {
          const budget = plan.budgetUsd === null ? "" : ` de ${formatUsd(plan.budgetUsd)}`;
          switch (event.type) {
            case "cell_start":
              out.line(
                `[${event.cell.index}/${event.total}] ${event.cell.taskId} × ${event.cell.model} ...`,
              );
              break;
            case "cell_end": {
              const r = event.result;
              const verdict = r.outcome === "pass" ? "aprovada" : "REPROVADA";
              const why =
                r.outcome === "pass"
                  ? ""
                  : ` (${r.failureOrigin ?? "?"}: ${(r.failureDetail ?? "").replace(/\s+/g, " ").slice(0, 110)})`;
              out.line(
                `[${event.cell.index}/${event.total}] ${r.taskId} × ${r.model}: ${verdict}${why} · ${r.turns} turnos · ${formatUsd(r.costUsd)} · gasto até agora: ${formatUsd(event.spentUsd)}${budget}`,
              );
              break;
            }
            case "cell_skipped":
              out.line(
                `[${event.cell.index}/${event.total}] ${event.cell.taskId} × ${event.cell.model}: pulada · gasto até agora: ${formatUsd(event.spentUsd)}${budget}`,
              );
              break;
            case "warning":
              out.warn(event.message);
              break;
            default:
              break;
          }
        },
      });
    } catch (error) {
      if (error instanceof EvalSetupError) throw new CommandError(error.message);
      throw error;
    } finally {
      unsubscribe();
    }

    // History first: the Markdown shows what changed since the last evaluation.
    const historyPath = resolve(ctx.io.cwd, str(ctx.args, "history") ?? DEFAULT_HISTORY_FILE);
    const { notes } = await recordHistory(report, historyPath);

    const dir = resolve(
      ctx.io.cwd,
      str(ctx.args, "out") ?? `.suup/evals/${stamp(new Date(report.startedAt))}`,
    );
    await mkdir(dir, { recursive: true });
    const jsonFile = resolve(dir, "report.json");
    const markdownFile = resolve(dir, "report.md");
    await writeFile(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownFile, renderMarkdown(report, notes), "utf8");

    const failed = report.cells.filter((c) => c.outcome === "fail");
    const skipped = report.cells.filter(isSkipped);
    const allPassed = failed.length === 0 && skipped.length === 0;

    if (ctx.json) {
      out.data({ report, files: { json: jsonFile, markdown: markdownFile }, history: notes });
      return allPassed ? EXIT_OK : EXIT_FAILED;
    }

    out.line("");
    out.line("Resultado por modelo");
    out.lines(
      renderTable(
        [
          "MODELO",
          "VERSÃO SERVIDA",
          "APROVADAS",
          "CONCLUSÃO",
          "ARGS INV.",
          "REVISOR",
          "TURNOS",
          "CUSTO/EXEC",
          "QUALIFICAÇÃO",
        ],
        report.summary.map((s) => {
          const q = isQualified(s);
          return [
            s.model,
            s.modelVersions.join(", ") || "n/d",
            `${s.passed}/${s.executed} (${pct(s.passRate)})`,
            pct(s.completionRate),
            pct(s.invalidArgRate),
            pct(s.reviewerRejectionRate),
            num(s.turnsPerRun),
            s.costPerRun === null ? "n/d" : formatUsd(s.costPerRun),
            q === null ? "não rodou" : q ? "qualificado" : "REPROVADO",
          ];
        }),
      ),
    );
    out.line("");
    out.line("Matriz");
    out.lines(
      renderTable(
        ["TAREFA", ...report.models.map((m) => m.id)],
        report.tasks.map((t) => [
          t.id,
          ...report.models.map((m) => {
            const cells = report.cells.filter((c) => c.taskId === t.id && c.model === m.id);
            const ran = cells.filter((c) => !isSkipped(c));
            if (ran.length === 0) return "skip";
            const ok = ran.filter((c) => c.outcome === "pass").length;
            const mark = ok === ran.length ? "✓" : ok === 0 ? "✗" : "~";
            return ran.length === 1 ? mark : `${mark} ${ok}/${ran.length}`;
          }),
        ]),
      ),
    );
    out.line("");
    for (const note of notes) {
      out.line(`Histórico de ${note.model}:`);
      for (const line of note.lines) out.line(`  ${line}`);
      if (note.warning !== undefined) out.warn(note.warning);
    }
    out.line("");
    out.line(
      `Gasto: ${formatUsd(report.spentUsd)}${report.budgetUsd === null ? "" : ` de ${formatUsd(report.budgetUsd)}`} · duração: ${formatDuration(new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime())}`,
    );
    if (failed.length > 0) {
      out.line(
        `${failed.length} célula(s) reprovada(s); no relatório, cada uma traz o id da execução e os comandos para diagnosticar (suup show, inspect, replay, resend).`,
      );
    }
    if (skipped.length > 0)
      out.line(`${skipped.length} célula(s) puladas: a avaliação está incompleta.`);
    out.line(`Relatórios: ${markdownFile}  ·  ${jsonFile}`);
    out.line(`Histórico: ${historyPath}`);
    return allPassed ? EXIT_OK : EXIT_FAILED;
  },
};

export const evalList: CommandSpec = {
  name: "eval list",
  summary: "Lista as tarefas da avaliação, com o que cada uma verifica e seus limites",
  options: {},
  positionals: { names: [] },
  async run(ctx) {
    const row = (t: EvalTask) => [
      t.id,
      t.category,
      String(t.limits.maxTurns),
      formatUsd(t.limits.maxCostUsd),
      formatDuration(t.limits.maxDurationMs),
      t.expect.status === "done" ? "concluir" : "escalar",
      t.title,
    ];
    if (ctx.json) {
      ctx.out.data(
        [
          ...evalTasks.map((t) => ({ set: "main", t })),
          ...qualificationTasks.map((t) => ({ set: "qualification", t })),
          ...hardTasks.map((t) => ({ set: "hard", t })),
        ].map(({ set, t }) => ({
          id: t.id,
          set,
          title: t.title,
          category: t.category,
          objective: t.objective,
          criteria: t.criteria,
          limits: t.limits,
          expectedStatus: t.expect.status,
          extraTools: (t.tools ?? []).map((tool) => tool.name),
          hasInboxScript: (t.inboxScript?.length ?? 0) > 0,
        })),
      );
      return EXIT_OK;
    }
    const header = [
      "ID",
      "CATEGORIA",
      "TURNOS",
      "CUSTO MÁX.",
      "DURAÇÃO MÁX.",
      "PASSA AO",
      "O QUE MEDE",
    ];
    ctx.out.line(`Conjunto principal (${evalTasks.length} tarefas)`);
    ctx.out.lines(renderTable(header, evalTasks.map(row)));
    ctx.out.line("");
    ctx.out.line(`Qualificação de modelo (${qualificationTasks.length} tarefas; use --qualify)`);
    ctx.out.lines(renderTable(header, qualificationTasks.map(row)));
    ctx.out.line("");
    ctx.out.line(
      `Conjunto difícil (${hardTasks.length} tarefas longas; use --hard; fora da execução padrão e do histórico dela)`,
    );
    ctx.out.lines(renderTable(header, hardTasks.map(row)));
    const worst = (list: readonly EvalTask[]) => list.reduce((s, t) => s + t.limits.maxCostUsd, 0);
    ctx.out.line("");
    ctx.out.line(
      `Pior caso por modelo (todas as execuções no teto): ${formatUsd(worst(evalTasks))} no conjunto principal, ${formatUsd(worst(qualificationTasks))} na qualificação, ${formatUsd(worst(hardTasks))} no conjunto difícil. O custo real costuma ser uma fração disso.`,
    );
    ctx.out.line("Veja o que cada tarefa mede em docs/AVALIACAO.md.");
    return EXIT_OK;
  },
};

export const evalHistory: CommandSpec = {
  name: "eval history",
  summary: "Mostra o histórico de avaliações por modelo (nota, métricas e versão servida)",
  options: {
    model: { type: "string", value: "modelo", help: "Só este modelo" },
    history: {
      type: "string",
      value: "arquivo",
      help: `Arquivo do histórico (padrão ${DEFAULT_HISTORY_FILE})`,
    },
  },
  positionals: { names: [] },
  async run(ctx) {
    const path = resolve(ctx.io.cwd, str(ctx.args, "history") ?? DEFAULT_HISTORY_FILE);
    const model = str(ctx.args, "model");
    const all = await readHistory(path);
    const entries = model === undefined ? all : all.filter((e) => e.model === model);
    if (ctx.json) {
      ctx.out.data(entries);
      return EXIT_OK;
    }
    if (entries.length === 0) {
      ctx.out.line(
        all.length === 0
          ? `Nenhum registro em ${path}. Cada suup eval acrescenta uma linha por modelo.`
          : `Nenhum registro do modelo ${JSON.stringify(model)} em ${path}.`,
      );
      return EXIT_OK;
    }
    const last = new Map<string, HistoryEntry>();
    const rows = entries.map((e) => {
      // A hard run is never compared with a default one: the change is against the same set only.
      const key = `${e.model}|${e.set ?? e.suite}`;
      const before = last.get(key);
      last.set(key, e);
      const change =
        before === undefined
          ? "primeiro"
          : `${e.passRate - before.passRate >= 0 ? "+" : "−"}${Math.abs((e.passRate - before.passRate) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pp${before.modelVersion !== e.modelVersion && before.modelVersion !== "" && e.modelVersion !== "" ? " (VERSÃO MUDOU)" : ""}`;
      return [
        formatDateTime(new Date(e.date)),
        e.model,
        e.modelVersion === "" ? "n/d" : e.modelVersion,
        `${e.passed}/${e.executed} (${pct(e.passRate)})`,
        change,
        pct(e.metrics.completionRate),
        pct(e.metrics.invalidArgRate),
        num(e.metrics.turnsPerRun),
        e.metrics.costPerRun === null ? "n/d" : formatUsd(e.metrics.costPerRun),
        e.qualified === null ? "—" : e.qualified ? "qualificado" : "REPROVADO",
        SET_NAME[e.set ?? "legacy"] ?? "—",
      ];
    });
    ctx.out.lines(
      renderTable(
        [
          "DATA",
          "MODELO",
          "VERSÃO SERVIDA",
          "APROVADAS",
          "MUDANÇA",
          "CONCLUSÃO",
          "ARGS INV.",
          "TURNOS",
          "CUSTO/EXEC",
          "QUALIFICAÇÃO",
          "CONJUNTO",
        ],
        rows,
      ),
    );
    ctx.out.line("");
    ctx.out.line(
      'pp = pontos percentuais. "VERSÃO MUDOU": o provedor serviu outra versão do modelo; uma mudança de nota sem mudança de código aponta para o modelo.',
    );
    return EXIT_OK;
  },
};
