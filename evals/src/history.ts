import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { dateTime, num, pct, points, usd } from "./fmt.js";
import { hardTasks } from "./hard/index.js";
import { qualificationTasks } from "./qualify/index.js";
import { type EvalReport, type HistoryNote, isQualified, type ModelSummary } from "./report.js";
import { evalTasks } from "./tasks/index.js";

/** Where the history lives, relative to the directory the CLI runs in. */
export const DEFAULT_HISTORY_FILE = ".suup/evals/history.jsonl";

/** Which of the task sets a run belongs to. Only entries of the same set are ever compared. */
export const TASK_SETS = ["main", "qualification", "hard", "mixed"] as const;
export type TaskSet = (typeof TASK_SETS)[number];

const SET_LABEL: Record<TaskSet, string> = {
  main: "principal",
  qualification: "de qualificação",
  hard: "difícil (--hard)",
  mixed: "misto (tarefas de conjuntos diferentes)",
};

/**
 * The set the tasks come from: all from the main set (a category or a few of its tasks count),
 * all from the hard set, all from the qualification set, or `mixed`. A hard run and a main run are
 * different sets, so a hard run is never compared with a default one.
 */
export function taskSetOf(taskIds: readonly string[]): TaskSet {
  if (taskIds.length === 0) return "mixed";
  const within = (list: readonly { id: string }[]) =>
    taskIds.every((id) => list.some((t) => t.id === id));
  if (within(hardTasks)) return "hard";
  if (within(evalTasks)) return "main";
  if (within(qualificationTasks)) return "qualification";
  return "mixed";
}

export const historyEntrySchema = z.object({
  /** ISO date of the evaluation. */
  date: z.string(),
  model: z.string(),
  /** What the provider reported it served (several versions joined by ", "); `""` when unknown. */
  modelVersion: z.string(),
  /** Which tasks were run: only the same set is comparable. */
  suite: z.string(),
  /** The task set (main, qualification, hard). Entries from before it existed have none. */
  set: z.enum(TASK_SETS).optional(),
  passRate: z.number().min(0).max(1),
  executed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  qualified: z.boolean().nullable(),
  metrics: z.object({
    completionRate: z.number().nullable(),
    invalidArgRate: z.number().nullable(),
    reviewerRejectionRate: z.number().nullable(),
    turnsPerRun: z.number().nullable(),
    costPerRun: z.number().nullable(),
  }),
  costUsd: z.number().nonnegative(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** A short, stable name for the set of tasks that were run. */
export function suiteId(taskIds: readonly string[]): string {
  return createHash("sha256")
    .update([...taskIds].sort().join(","))
    .digest("hex")
    .slice(0, 8);
}

/** One entry per model that executed at least one cell. */
export function historyEntries(report: EvalReport): HistoryEntry[] {
  const suite = suiteId(report.tasks.map((t) => t.id));
  const set = taskSetOf(report.tasks.map((t) => t.id));
  return report.summary
    .filter((s) => s.executed > 0 && s.passRate !== null)
    .map((s: ModelSummary) => ({
      date: report.finishedAt,
      model: s.model,
      modelVersion: s.modelVersions.join(", "),
      suite,
      set,
      passRate: s.passRate as number,
      executed: s.executed,
      passed: s.passed,
      qualified: isQualified(s),
      metrics: {
        completionRate: s.completionRate,
        invalidArgRate: s.invalidArgRate,
        reviewerRejectionRate: s.reviewerRejectionRate,
        turnsPerRun: s.turnsPerRun,
        costPerRun: s.costPerRun,
      },
      costUsd: s.costUsd,
    }));
}

/** Reads the history; lines that are not valid entries are skipped. A missing file is empty. */
export async function readHistory(path: string): Promise<HistoryEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = historyEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // a damaged line must not hide the rest
    }
  }
  return entries;
}

export async function appendHistory(path: string, entries: readonly HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
}

const delta = (now: number | null, before: number | null, format: (n: number) => string) =>
  now === null || before === null ? "n/d" : `${format(before)} → ${format(now)}`;

/**
 * Compares a new entry with the last earlier one of the same model (preferring one that ran the
 * same tasks). Says so when the model version the provider served is not the one it served last
 * time: a change of grade with no change of code points at the model.
 */
export function compareWithPrevious(
  entry: HistoryEntry,
  history: readonly HistoryEntry[],
): HistoryNote {
  // Never across task sets: a hard run says nothing about a default one. Entries recorded before
  // the set was kept are comparable only when they ran exactly the same tasks.
  const mine = history.filter(
    (h) =>
      h.model === entry.model &&
      h.date < entry.date &&
      (h.set === undefined ? h.suite === entry.suite : h.set === entry.set),
  );
  const sameSuite = mine.filter((h) => h.suite === entry.suite);
  const previous = (sameSuite.length > 0 ? sameSuite : mine).at(-1);
  if (previous === undefined) {
    const otherSets = history.some((h) => h.model === entry.model && h.date < entry.date);
    return {
      model: entry.model,
      lines: [
        entry.set === undefined
          ? "Primeira avaliação registrada deste modelo: sem comparação."
          : `Primeira avaliação registrada deste modelo no conjunto ${SET_LABEL[entry.set]}: sem comparação${otherSets ? " (as avaliações de outros conjuntos não são comparáveis)" : ""}.`,
      ],
    };
  }
  const change = entry.passRate - previous.passRate;
  const lines = [
    `Taxa de aprovação: ${pct(previous.passRate)} (${previous.passed}/${previous.executed}) em ${dateTime(new Date(previous.date))} → ${pct(entry.passRate)} (${entry.passed}/${entry.executed}) agora: ${change === 0 ? "sem mudança" : points(change)}.`,
    `Turnos por execução: ${delta(entry.metrics.turnsPerRun, previous.metrics.turnsPerRun, num)} · custo por execução: ${delta(entry.metrics.costPerRun, previous.metrics.costPerRun, usd)} · argumentos inválidos: ${delta(entry.metrics.invalidArgRate, previous.metrics.invalidArgRate, pct)}.`,
  ];
  if (sameSuite.length === 0) {
    lines.push(
      "Atenção: o conjunto de tarefas é diferente do da avaliação anterior; a comparação é só indicativa.",
    );
  }
  const note: HistoryNote = { model: entry.model, lines };
  if (
    previous.modelVersion !== entry.modelVersion &&
    previous.modelVersion !== "" &&
    entry.modelVersion !== ""
  ) {
    note.warning = `A versão servida do modelo ${entry.model} mudou desde a avaliação anterior: ${previous.modelVersion} → ${entry.modelVersion}. Uma mudança de nota sem mudança de código aponta para o modelo, não para o harness.`;
  }
  return note;
}

/**
 * Appends this evaluation to the history and compares it with the earlier entries. Returns one
 * note per model, for the report and the terminal.
 */
export async function recordHistory(
  report: EvalReport,
  path: string,
): Promise<{ entries: HistoryEntry[]; notes: HistoryNote[] }> {
  const before = await readHistory(path);
  const entries = historyEntries(report);
  const notes = entries.map((entry) => compareWithPrevious(entry, before));
  await appendHistory(path, entries);
  return { entries, notes };
}
