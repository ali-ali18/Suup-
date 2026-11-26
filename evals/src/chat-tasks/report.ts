// Owns the text of the chat-or-task report: per category against the earlier run, how the long
// work moved (the bot or the brake, and after how many steps), the latency and the cost.
import { duration, usd } from "../fmt.js";
import { CHAT_TASK_CATEGORIES, type ChatTaskCategory } from "./cases.js";
import type { ChatTaskReport, ChatTaskResult } from "./run.js";

const CATEGORY_PT: Record<ChatTaskCategory, string> = {
  quick: "rápidos (responder no chat)",
  long: "longos (virar tarefa)",
  multi: "vários pedidos (uma tarefa por pedido longo)",
  followup: "seguimento (repassar à tarefa aberta)",
};

const VARIANT_PT = {
  a: "A (só o prompt reforçado)",
  b: "B (prompt + freio cedo + conferência no fim)",
} as const;

/** The value at a share of a sorted list (nearest rank). */
export function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(share * sorted.length)));
  return sorted[rank - 1] ?? null;
}

const ms = (value: number | null) => (value === null ? "n/d" : duration(value));

function latency(results: readonly ChatTaskResult[], pick: (r: ChatTaskResult) => number | null) {
  const values = results.map(pick).filter((v): v is number => v !== null);
  return `mediana ${ms(percentile(values, 0.5))}, p90 ${ms(percentile(values, 0.9))}`;
}

export function formatChatTaskReport(report: ChatTaskReport): string[] {
  const lines = [`Chat ou tarefa · variante ${VARIANT_PT[report.variant]} · modelo ${report.model}`];
  for (const summary of report.categories) {
    const before =
      summary.baseline === null
        ? "sem referência anterior"
        : `antes ${summary.baseline.passed}/${summary.baseline.total}`;
    lines.push(
      `  ${CATEGORY_PT[summary.category]}: ${summary.passed}/${summary.total} (${before})${summary.failedIds.length === 0 ? "" : ` · falharam: ${summary.failedIds.join(", ")}`}`,
    );
  }
  const moved = report.results.filter((r) => r.category === "long" && r.tasks > 0);
  if (moved.length > 0) {
    const byBot = moved.filter((r) => !r.byBrake).length;
    const steps = moved.map((r) => r.stepsBeforeTask ?? 0);
    const mean = steps.reduce((s, n) => s + n, 0) / steps.length;
    lines.push(
      `  longos que viraram tarefa: ${byBot} pelo próprio bot, ${moved.length - byBot} pelo freio; passos no chat antes da tarefa: média ${mean.toFixed(1)}, máximo ${Math.max(...steps)}`,
    );
  }
  const capped = report.results.filter((r) => r.capped).map((r) => r.id);
  if (capped.length > 0) lines.push(`  presos no chat até o limite do eval: ${capped.join(", ")}`);
  const nudged = report.results.filter((r) => (r.unhandledAsks ?? []).length > 0);
  if (nudged.length > 0) {
    lines.push(
      `  conferência no fim achou pedidos esquecidos em: ${nudged.map((r) => r.id).join(", ")}`,
    );
  }
  lines.push(`  latência até a primeira resposta: ${latency(report.results, (r) => r.firstReplyMs)}`);
  lines.push(`  latência até o fim do turno: ${latency(report.results, (r) => r.endMs)}`);
  for (const category of CHAT_TASK_CATEGORIES) {
    const own = report.results.filter((r) => r.category === category);
    if (own.length === 0) continue;
    lines.push(
      `    ${category}: primeira resposta ${latency(own, (r) => r.firstReplyMs)} · custo ${usd(own.reduce((s, r) => s + r.costUsd, 0))}`,
    );
  }
  const count = report.results.length;
  lines.push(
    `  custo: ${usd(report.totalCostUsd)} em ${count} casos (${usd(count === 0 ? 0 : report.totalCostUsd / count)} por caso)`,
  );
  if (report.notRun.length > 0) {
    lines.push(`  NÃO RODARAM (orçamento): ${report.notRun.join(", ")}`);
  }
  return lines;
}
