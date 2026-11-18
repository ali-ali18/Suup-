import { FAILURE_ORIGINS, runStatusSchema } from "@suup/core";
import { z } from "zod";
import { dateTime, duration, num, pct, usd } from "./fmt.js";
import { EVAL_CATEGORIES, type EvalCategory } from "./types.js";

/** Where a failed cell went wrong: the run's own failure origins, plus two of the evaluation's. */
export const CELL_ORIGINS = [...FAILURE_ORIGINS, "outcome", "eval"] as const;
export type CellOrigin = (typeof CELL_ORIGINS)[number];

export const ORIGIN_MEANING: Record<CellOrigin, string> = {
  provider: "o provedor do modelo falhou (rede, chave, limite de taxa, resposta inválida)",
  model: "o modelo se comportou mal (recusou, parou sem concluir, repetiu a mesma chamada)",
  tool: "uma ferramenta ou a máquina dos bots falhou",
  harness: "falha do próprio harness (exceção no loop, conversa inválida)",
  limit: "um limite foi atingido (turnos, custo ou duração)",
  approval: "uma aprovação foi negada",
  user: "a execução foi encerrada por uma pessoa",
  outcome:
    "a execução terminou normalmente, mas o resultado está errado: é preciso olhar o que o modelo viu (inspect, replay, resend) para saber se foi o modelo ou o harness",
  eval: "falha do avaliador (preparação da tarefa, verificação ou tempo limite do runner), não da execução",
};

const checkSchema = z.object({
  name: z.string(),
  pass: z.boolean(),
  detail: z.exactOptional(z.string()),
});

const observationValue = z.union([z.string(), z.number(), z.boolean()]);

export const cellResultSchema = z.object({
  taskId: z.string(),
  category: z.enum(EVAL_CATEGORIES),
  model: z.string(),
  /** 1-based. */
  repetition: z.number().int().positive(),
  outcome: z.enum(["pass", "fail", "skipped_budget", "skipped_interrupted"]),
  checks: z.array(checkSchema),
  observations: z.exactOptional(z.record(z.string(), observationValue)),
  expectedStatus: z.enum(["done", "waiting_user"]),
  finalStatus: runStatusSchema.nullable(),
  failureOrigin: z.enum(CELL_ORIGINS).nullable(),
  failureDetail: z.string().nullable(),
  /** Use it with `suup show`, `inspect`, `replay` and `resend`. */
  runId: z.string().nullable(),
  /** The bot that did the work; its workspace is `<sandbox>/bots/<botId>`. */
  botId: z.string().nullable(),
  /** The `seq` of the last model request of the run, for `suup resend --seq`. */
  lastRequestSeq: z.number().int().nullable(),
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** What the provider said it served, on the agent's turns. */
  modelVersions: z.array(z.string()),
  nudges: z.number().int().nonnegative(),
  finishRejections: z.object({
    harness: z.number().int().nonnegative(),
    reviewer: z.number().int().nonnegative(),
  }),
  reviews: z.number().int().nonnegative(),
  reviewerRejects: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolErrors: z.number().int().nonnegative(),
  invalidArgs: z.number().int().nonnegative(),
});
export type CellResult = z.infer<typeof cellResultSchema>;

/** A cell that never ran (no budget left, or the evaluation was interrupted). */
export const isSkipped = (cell: Pick<CellResult, "outcome">): boolean =>
  cell.outcome === "skipped_budget" || cell.outcome === "skipped_interrupted";

const rate = z.number().min(0).max(1).nullable();

export const modelSummarySchema = z.object({
  model: z.string(),
  cells: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  passRate: rate,
  byCategory: z.record(
    z.string(),
    z.object({ executed: z.number().int(), passed: z.number().int(), passRate: rate }),
  ),
  /** Runs that ended `done` or waiting for the user, out of the runs executed. */
  completionRate: rate,
  /** Calls with invalid arguments, out of all tool calls. */
  invalidArgRate: rate,
  /** Reviews that said no, out of the reviews done. `null` without a reviewer. */
  reviewerRejectionRate: rate,
  finishRejections: z.object({ harness: z.number().int(), reviewer: z.number().int() }),
  turnsPerRun: z.number().nullable(),
  costPerRun: z.number().nullable(),
  nudgesPerRun: z.number().nullable(),
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  failureOrigins: z.record(z.string(), z.number().int()),
  modelVersions: z.array(z.string()),
  /** The qualification tasks (PLANO 4.13): `null` when none was run for this model. */
  qualification: z
    .object({ executed: z.number().int(), passed: z.number().int(), required: z.number().int() })
    .nullable(),
});
export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const evalReportSchema = z.object({
  schemaVersion: z.literal(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** `null`: no budget (every model is the scripted provider). */
  budgetUsd: z.number().nullable(),
  spentUsd: z.number().nonnegative(),
  maxCostPerRunUsd: z.number().nullable(),
  repeat: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      scripted: z.boolean(),
      /** Without pricing the cost cannot be measured or budgeted. */
      priced: z.boolean(),
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category: z.enum(EVAL_CATEGORIES),
      limits: z.object({
        maxTurns: z.number().int(),
        maxCostUsd: z.number(),
        maxDurationMs: z.number().int(),
      }),
    }),
  ),
  cells: z.array(cellResultSchema),
  summary: z.array(modelSummarySchema),
  warnings: z.array(z.string()),
});
export type EvalReport = z.infer<typeof evalReportSchema>;

/** Validates a report read from JSON. Throws a `ZodError`. */
export const parseReport = (raw: unknown): EvalReport => evalReportSchema.parse(raw);

// --- aggregation -------------------------------------------------------------------------

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const mean = (total: number, count: number): number | null => (count === 0 ? null : total / count);
const sum = (cells: readonly CellResult[], pick: (c: CellResult) => number): number =>
  cells.reduce((total, c) => total + pick(c), 0);

/** The per-model numbers of PLANO 4.13, from the cells of one model. */
export function summarizeModel(
  model: string,
  cells: readonly CellResult[],
  qualificationTaskIds: readonly string[] = [],
): ModelSummary {
  const mine = cells.filter((c) => c.model === model);
  const executed = mine.filter((c) => !isSkipped(c));
  const passed = executed.filter((c) => c.outcome === "pass");
  const byCategory: ModelSummary["byCategory"] = {};
  for (const category of EVAL_CATEGORIES) {
    const inCategory = executed.filter((c) => c.category === category);
    if (inCategory.length === 0) continue;
    const ok = inCategory.filter((c) => c.outcome === "pass").length;
    byCategory[category] = {
      executed: inCategory.length,
      passed: ok,
      passRate: ratio(ok, inCategory.length),
    };
  }
  const origins: Record<string, number> = {};
  for (const cell of executed) {
    if (cell.outcome === "fail" && cell.failureOrigin !== null) {
      origins[cell.failureOrigin] = (origins[cell.failureOrigin] ?? 0) + 1;
    }
  }
  const versions: string[] = [];
  for (const cell of executed) {
    for (const v of cell.modelVersions) if (!versions.includes(v)) versions.push(v);
  }
  const qualCells = executed.filter((c) => qualificationTaskIds.includes(c.taskId));
  const completed = executed.filter(
    (c) => c.finalStatus === "done" || c.finalStatus === "waiting_user",
  );
  return {
    model,
    cells: mine.length,
    executed: executed.length,
    skipped: mine.length - executed.length,
    passed: passed.length,
    passRate: ratio(passed.length, executed.length),
    byCategory,
    completionRate: ratio(completed.length, executed.length),
    invalidArgRate: ratio(
      sum(executed, (c) => c.invalidArgs),
      sum(executed, (c) => c.toolCalls),
    ),
    reviewerRejectionRate: ratio(
      sum(executed, (c) => c.reviewerRejects),
      sum(executed, (c) => c.reviews),
    ),
    finishRejections: {
      harness: sum(executed, (c) => c.finishRejections.harness),
      reviewer: sum(executed, (c) => c.finishRejections.reviewer),
    },
    turnsPerRun: mean(
      sum(executed, (c) => c.turns),
      executed.length,
    ),
    costPerRun: mean(
      sum(executed, (c) => c.costUsd),
      executed.length,
    ),
    nudgesPerRun: mean(
      sum(executed, (c) => c.nudges),
      executed.length,
    ),
    costUsd: sum(mine, (c) => c.costUsd),
    inputTokens: sum(mine, (c) => c.inputTokens),
    outputTokens: sum(mine, (c) => c.outputTokens),
    failureOrigins: origins,
    modelVersions: versions,
    qualification:
      qualCells.length === 0
        ? null
        : {
            executed: qualCells.length,
            passed: qualCells.filter((c) => c.outcome === "pass").length,
            required: qualificationTaskIds.length,
          },
  };
}

/** Whether the model passed the qualification (every qualification task, all passed). */
export function isQualified(summary: ModelSummary): boolean | null {
  const q = summary.qualification;
  if (q === null) return null;
  return q.executed >= q.required && q.passed === q.executed;
}

// --- Markdown ----------------------------------------------------------------------------

/** What `recordHistory` found for one model: shown in the Markdown and on the terminal. */
export interface HistoryNote {
  model: string;
  lines: string[];
  warning?: string;
}

const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  row(header),
  row(header.map(() => "---")),
  ...rows.map(row),
];

const mark = (executed: CellResult[]): string => {
  if (executed.length === 0) return "skip";
  const ok = executed.filter((c) => c.outcome === "pass").length;
  if (executed.length === 1) return ok === 1 ? "✓" : "✗";
  return `${ok === executed.length ? "✓" : ok === 0 ? "✗" : "~"} ${ok}/${executed.length}`;
};

/** The command lines to run next for a failed cell, in the order of PLANO 4.13. */
export function diagnosticCommands(cell: CellResult): string[] {
  if (cell.runId === null) return [];
  const id = cell.runId.slice(0, 8);
  const commands = [`suup show ${id}`, `suup inspect ${id} --type tool_call,tool_result --full`];
  if (cell.failureOrigin === "provider") commands.push("suup doctor");
  if (cell.lastRequestSeq !== null) {
    commands.push(`suup inspect ${id} --request ${cell.lastRequestSeq}`);
  }
  commands.push(`suup replay ${id}`);
  if (cell.lastRequestSeq !== null) {
    commands.push(
      `suup resend ${id} --seq ${cell.lastRequestSeq} --times 5`,
      `suup resend ${id} --seq ${cell.lastRequestSeq} --model <outro-modelo>`,
    );
  }
  return commands;
}

export function renderMarkdown(report: EvalReport, history: readonly HistoryNote[] = []): string {
  const out: string[] = [];
  const models = report.models.map((m) => m.id);
  const started = new Date(report.startedAt);
  const executed = report.cells.filter((c) => !isSkipped(c));
  const skipped = report.cells.length - executed.length;

  out.push(
    `# Avaliação do harness: ${dateTime(started)}`,
    "",
    `- Modelos: ${models.join(", ")}`,
    `- Tarefas: ${report.tasks.length} · repetições: ${report.repeat} · células: ${report.cells.length} (${executed.length} executadas, ${skipped} puladas)`,
    `- Gasto: ${usd(report.spentUsd)}${report.budgetUsd === null ? " (sem orçamento: só provedor de roteiro)" : ` de ${usd(report.budgetUsd)}`}${report.maxCostPerRunUsd === null ? "" : ` · teto por execução: ${usd(report.maxCostPerRunUsd)}`}`,
    `- Duração: ${duration(new Date(report.finishedAt).getTime() - started.getTime())}`,
    "",
  );

  if (report.warnings.length > 0 || history.some((h) => h.warning !== undefined)) {
    out.push("## Avisos", "");
    for (const w of report.warnings) out.push(`- ${w}`);
    for (const h of history) if (h.warning !== undefined) out.push(`- **${h.warning}**`);
    out.push("");
  }

  out.push("## Resumo por modelo", "");
  out.push(
    ...table(
      [
        "Modelo",
        "Versão servida",
        "Aprovadas",
        "Conclusão",
        "Args inválidos",
        "Recusa do revisor",
        "Turnos/exec.",
        "Custo/exec.",
        "Custo total",
        "Qualificação",
      ],
      report.summary.map((s) => {
        const q = isQualified(s);
        return [
          s.model,
          s.modelVersions.length === 0 ? "n/d" : s.modelVersions.join(", "),
          `${s.passed}/${s.executed} (${pct(s.passRate)})`,
          pct(s.completionRate),
          pct(s.invalidArgRate),
          pct(s.reviewerRejectionRate),
          num(s.turnsPerRun),
          s.costPerRun === null ? "n/d" : usd(s.costPerRun),
          usd(s.costUsd),
          q === null
            ? "não rodou"
            : `${q ? "qualificado" : "REPROVADO"} (${s.qualification?.passed}/${s.qualification?.required})`,
        ];
      }),
    ),
    "",
  );

  out.push("## Matriz: tarefas × modelos", "");
  const matrixRows = report.tasks.map((task) => [
    `\`${task.id}\``,
    task.category,
    ...models.map((model) => {
      const cells = report.cells.filter((c) => c.taskId === task.id && c.model === model);
      const ran = cells.filter((c) => !isSkipped(c));
      const cost = ran.reduce((total, c) => total + c.costUsd, 0);
      return ran.length === 0 ? "skip" : `${mark(ran)} ${usd(cost)}`;
    }),
  ]);
  out.push(...table(["Tarefa", "Categoria", ...models], matrixRows), "");

  out.push("## Taxa de aprovação por categoria", "");
  const categoryRows = EVAL_CATEGORIES.filter((category) =>
    report.summary.some((s) => s.byCategory[category] !== undefined),
  ).map((category) => [
    category,
    ...report.summary.map((s) => {
      const c = s.byCategory[category as EvalCategory];
      return c === undefined ? "n/d" : `${pct(c.passRate)} (${c.passed}/${c.executed})`;
    }),
  ]);
  out.push(...table(["Categoria", ...models], categoryRows), "");

  out.push("## Origem das falhas", "");
  const originRows = CELL_ORIGINS.filter((o) =>
    report.summary.some((s) => (s.failureOrigins[o] ?? 0) > 0),
  ).map((o) => [`\`${o}\``, ...report.summary.map((s) => String(s.failureOrigins[o] ?? 0))]);
  if (originRows.length === 0) out.push("Nenhuma célula falhou.", "");
  else {
    out.push(...table(["Origem", ...models], originRows), "");
    out.push(
      ...CELL_ORIGINS.filter((o) => originRows.some((r) => r[0] === `\`${o}\``)).map(
        (o) => `- \`${o}\`: ${ORIGIN_MEANING[o]}.`,
      ),
      "",
    );
  }

  const rejections = report.summary.filter(
    (s) => s.finishRejections.harness + s.finishRejections.reviewer > 0,
  );
  if (rejections.length > 0) {
    out.push(
      "Recusas de `finish`: " +
        rejections
          .map(
            (s) =>
              `${s.model}: ${s.finishRejections.harness} pelo harness, ${s.finishRejections.reviewer} pelo revisor`,
          )
          .join("; ") +
        ".",
      "",
    );
  }

  if (history.length > 0) {
    out.push("## Histórico", "");
    for (const h of history) {
      out.push(`**${h.model}**`, "", ...h.lines.map((l) => `- ${l}`), "");
    }
  }

  const failures = report.cells.filter((c) => c.outcome === "fail");
  out.push("## Falhas", "");
  if (failures.length === 0) out.push("Nenhuma.", "");
  for (const cell of failures) {
    out.push(
      `### ${cell.taskId} × ${cell.model}${report.repeat > 1 ? ` (repetição ${cell.repetition})` : ""}`,
      "",
      `- Execução: ${cell.runId === null ? "(não chegou a ser criada)" : `\`${cell.runId}\``}${cell.botId === null ? "" : ` · bot \`${cell.botId}\``}`,
      `- Estado final: ${cell.finalStatus ?? "n/d"} (esperado: ${cell.expectedStatus}) · ${cell.turns} turnos · ${usd(cell.costUsd)} · ${duration(cell.durationMs)}`,
      `- Origem: \`${cell.failureOrigin ?? "n/d"}\`${cell.failureOrigin === null ? "" : `: ${ORIGIN_MEANING[cell.failureOrigin]}`}`,
    );
    if (cell.failureDetail !== null && cell.failureDetail !== "") {
      out.push(`- Detalhe: ${cell.failureDetail}`);
    }
    if (cell.modelVersions.length > 0)
      out.push(`- Versão servida: ${cell.modelVersions.join(", ")}`);
    out.push(
      `- Recusas de finish: ${cell.finishRejections.harness} do harness, ${cell.finishRejections.reviewer} do revisor · avisos do harness (nudges): ${cell.nudges} · argumentos inválidos: ${cell.invalidArgs} · erros de ferramenta: ${cell.toolErrors}`,
    );
    const failed = cell.checks.filter((c) => !c.pass);
    if (failed.length > 0) {
      out.push("- Verificações reprovadas:");
      for (const c of failed)
        out.push(`  - ${c.name}${c.detail === undefined ? "" : `: ${c.detail}`}`);
    }
    if (cell.observations !== undefined) {
      out.push(
        `- Observações: ${Object.entries(cell.observations)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ")}`,
      );
    }
    const commands = diagnosticCommands(cell);
    if (commands.length > 0) {
      out.push(
        "- Para diagnosticar (do mais barato ao mais caro):",
        "",
        "  ```sh",
        ...commands.map((c) => `  ${c}`),
        "  ```",
      );
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
