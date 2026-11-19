import { CONSOLIDATION_PROMPT_VERSION, type ForcedCallModel, type Provider } from "@suup/core";
import {
  addMemory,
  appendMessage,
  createBot,
  createDirectConversation,
  type Db,
  getConsolidation,
  getMemory,
  listMemories,
} from "@suup/db";
import { runNextConsolidation } from "@suup/runtime";
import { CONSOLIDATION_CASES, type ConsolidationCase } from "./consolidation-cases.js";

export interface ConsolidationCaseResult {
  id: string;
  title: string;
  expectation: string;
  status: "done" | "skipped" | "failed" | "lost" | "no_run" | "over_budget";
  proposed: unknown[];
  kept: { action: string; layer: string; status: string; text: string; quote: string }[];
  dropped: { reason: string; detail: string }[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** What the harness guarantees (checked by code); a violation is a bug, not a model mistake. */
  invariants: {
    /** Every kept item has a quote that is word for word in a message of the user. */
    quotesVerified: boolean;
    /** None of the case's forbidden texts is in any memory. */
    forbiddenAbsent: boolean;
  };
}

export interface ConsolidationEvalReport {
  model: string;
  promptVersion: string;
  cases: ConsolidationCaseResult[];
  totals: {
    cases: number;
    proposed: number;
    kept: number;
    dropped: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    meanLatencyMs: number;
  };
  invariantsHold: boolean;
}

export interface RunConsolidationEvalOptions {
  db: Db;
  provider: Provider;
  model: ForcedCallModel;
  budgetUsd?: number;
  cases?: readonly ConsolidationCase[];
  onCase?(result: ConsolidationCaseResult, spent: number): void;
}

/**
 * Runs the consolidation (the real code path: claim, request, answer, checks, writes) over the
 * made-up conversations, in the database it is given (an empty, migrated schema), and reports
 * what the model proposed and what the harness did. The model is whatever `provider`/`model` say.
 */
export async function runConsolidationEval(
  options: RunConsolidationEvalOptions,
): Promise<ConsolidationEvalReport> {
  const { db } = options;
  const budget = options.budgetUsd ?? Number.POSITIVE_INFINITY;
  const results: ConsolidationCaseResult[] = [];
  let spent = 0;
  for (const c of options.cases ?? CONSOLIDATION_CASES) {
    if (spent >= budget) {
      const skipped: ConsolidationCaseResult = {
        id: c.id,
        title: c.title,
        expectation: c.expectation,
        status: "over_budget",
        proposed: [],
        kept: [],
        dropped: [],
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        invariants: { quotesVerified: true, forbiddenAbsent: true },
      };
      results.push(skipped);
      options.onCase?.(skipped, spent);
      continue;
    }
    // Each case starts from the shared memory it declares: what an earlier case proposed does not
    // leak into the next one (a pending or active shared memory is visible to every bot).
    await db.sql`update memories set archived_at = now() where scope = 'shared' and archived_at is null`;
    const bot = await createBot(db, {
      name: `eval-${c.id}`,
      modelProvider: "eval",
      modelId: options.model.id,
    });
    const conversation = await createDirectConversation(db, bot.id);
    for (const text of c.existing ?? []) {
      await addMemory(db, { layer: "note", botId: bot.id, text, createdBy: "bot" });
    }
    for (const m of c.messages) {
      await appendMessage(db, {
        conversationId: conversation.id,
        authorKind: m.author,
        ...(m.author === "bot" ? { authorBotId: bot.id } : {}),
        text: m.text,
      });
    }
    await db.sql`update messages set created_at = now() - interval '30 minutes' where conversation_id = ${conversation.id}`;

    const outcome = await runNextConsolidation({
      db,
      workerId: "eval",
      provider: options.provider,
      model: options.model,
    });
    const row = outcome === null ? null : await getConsolidation(db, outcome.consolidation.id);
    const kept = await Promise.all(
      (outcome?.kept ?? []).map(async (k) => ({
        action: k.action,
        layer: k.layer,
        status: (await getMemory(db, k.memoryId))?.status ?? k.status,
        text: k.text,
        quote: k.quote,
      })),
    );
    const userTexts = c.messages.filter((m) => m.author === "user").map((m) => m.text);
    // Everything this bot's consolidation could have written, in any state.
    const pendingAll = await listMemories(db, {
      limit: 1000,
      status: "pending",
      includeArchived: true,
    });
    const activeOfBot = await listMemories(db, {
      limit: 1000,
      botId: bot.id,
      includeArchived: true,
    });
    const everything = [
      ...activeOfBot,
      ...pendingAll.filter((m) => m.botId === bot.id || m.botId === null),
    ].map((m) => m.text);
    const result: ConsolidationCaseResult = {
      id: c.id,
      title: c.title,
      expectation: c.expectation,
      status: outcome === null ? "no_run" : outcome.status,
      proposed: Array.isArray(row?.proposed) ? (row.proposed as unknown[]) : [],
      kept,
      dropped: (outcome?.dropped ?? []).map((d) => ({ reason: d.reason, detail: d.detail })),
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      costUsd: row?.costUsd ?? 0,
      latencyMs: row?.latencyMs ?? 0,
      invariants: {
        quotesVerified: kept.every((k) => userTexts.some((t) => t.includes(k.quote))),
        forbiddenAbsent: (c.forbidden ?? []).every((f) => everything.every((t) => !t.includes(f))),
      },
    };
    spent += result.costUsd;
    results.push(result);
    options.onCase?.(result, spent);
  }
  const sum = (pick: (r: ConsolidationCaseResult) => number) =>
    results.reduce((n, r) => n + pick(r), 0);
  const ran = results.filter((r) => r.status === "done");
  return {
    model: options.model.id,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    cases: results,
    totals: {
      cases: results.length,
      proposed: sum((r) => r.proposed.length),
      kept: sum((r) => r.kept.length),
      dropped: sum((r) => r.dropped.length),
      costUsd: spent,
      inputTokens: sum((r) => r.inputTokens),
      outputTokens: sum((r) => r.outputTokens),
      meanLatencyMs: ran.length === 0 ? 0 : Math.round(sum((r) => r.latencyMs) / ran.length),
    },
    invariantsHold: results.every(
      (r) => r.invariants.quotesVerified && r.invariants.forbiddenAbsent,
    ),
  };
}

const usd = (n: number): string => `US$ ${n.toFixed(5)}`;

/** The report as text, for the terminal and for TESTES-REAIS.md. */
export function formatConsolidationReport(report: ConsolidationEvalReport): string {
  const lines = [
    `Consolidação em segundo plano: modelo ${report.model}, prompt ${report.promptVersion}, ${report.totals.cases} conversas inventadas.`,
    "",
  ];
  for (const c of report.cases) {
    lines.push(
      `[${c.id}] ${c.title} — ${c.status}${c.status === "done" ? ` · ${c.inputTokens}/${c.outputTokens} tokens · ${usd(c.costUsd)} · ${c.latencyMs} ms` : ""}`,
    );
    lines.push(`    esperado: ${c.expectation}`);
    lines.push(
      `    o modelo propôs ${c.proposed.length}; ficaram ${c.kept.length}; descartadas ${c.dropped.length}`,
    );
    for (const k of c.kept) {
      lines.push(`    ficou (${k.action}, ${k.layer}, ${k.status}): ${k.text}  ← "${k.quote}"`);
    }
    for (const d of c.dropped) lines.push(`    descartada (${d.reason}): ${d.detail}`);
    const i = c.invariants;
    if (!(i.quotesVerified && i.forbiddenAbsent)) {
      lines.push(`    VIOLAÇÃO DE GARANTIA: ${JSON.stringify(i)}`);
    }
  }
  lines.push("");
  lines.push(
    `Total: ${report.totals.proposed} propostas, ${report.totals.kept} ficaram, ${report.totals.dropped} descartadas · ${report.totals.inputTokens}/${report.totals.outputTokens} tokens · ${usd(report.totals.costUsd)} · latência média ${report.totals.meanLatencyMs} ms.`,
  );
  lines.push(`Garantias do harness: ${report.invariantsHold ? "todas valem" : "VIOLADAS"}.`);
  return lines.join("\n");
}
