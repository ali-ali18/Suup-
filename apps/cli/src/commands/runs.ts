import { runStatusSchema } from "@suup/core";
import { type Bot, getBot, listBots, listRuns, type Run } from "@suup/db";
import { posInt, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { EXIT_OK, UsageError } from "../errors.js";
import {
  formatDateTime,
  formatDuration,
  formatInt,
  formatUsd,
  indent,
  oneLine,
  originExplanation,
  statusPt,
} from "../format.js";
import { findBot, findRun, readEvents } from "../lookup.js";
import { renderPlan, typedEvent } from "../render.js";
import { renderTable } from "../table.js";

export function runJson(run: Run) {
  return {
    id: run.id,
    botId: run.botId,
    origin: run.origin,
    objective: run.objective,
    acceptanceCriteria: run.acceptanceCriteria,
    status: run.status,
    failureOrigin: run.failureOrigin,
    failureDetail: run.failureDetail,
    plan: run.plan,
    result: run.result,
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export const runsCommand: CommandSpec = {
  name: "runs",
  summary: "Lista as execuções recentes",
  options: {
    bot: { type: "string", value: "bot", help: "Só as execuções deste bot (id ou nome)" },
    status: {
      type: "string",
      value: "status",
      help: "Só neste status: queued, running, waiting_approval, waiting_user, done, failed, cancelled",
    },
    limit: { type: "string", value: "N", help: "Quantas mostrar (padrão 20)" },
  },
  positionals: { names: [] },
  async run(ctx) {
    const statusText = str(ctx.args, "status");
    let status: Run["status"] | undefined;
    if (statusText !== undefined) {
      const parsed = runStatusSchema.safeParse(statusText);
      if (!parsed.success) {
        throw new UsageError(
          `Status inválido: ${JSON.stringify(statusText)}. Use um de: ${runStatusSchema.options.join(", ")}.`,
          "runs",
        );
      }
      status = parsed.data;
    }
    const limit = posInt(ctx.args, "limit", "runs") ?? 20;
    const db = ctx.runtime().db;
    const botRef = str(ctx.args, "bot");
    let botId: string | undefined;
    if (botRef !== undefined) {
      botId = (await findBot(db, botRef)).id;
    }
    const runs = await listRuns(db, {
      limit,
      ...(botId === undefined ? {} : { botId }),
      ...(status === undefined ? {} : { status }),
    });
    if (ctx.json) {
      ctx.out.data(runs.map(runJson));
      return EXIT_OK;
    }
    if (runs.length === 0) {
      ctx.out.line("Nenhuma execução encontrada.");
      return EXIT_OK;
    }
    const names = new Map(
      (await listBots(db, { includeArchived: true })).map((b) => [b.id, b.name]),
    );
    ctx.out.lines(
      renderTable(
        ["ID", "SITUAÇÃO", "BOT", "TURNOS", "CUSTO", "CRIADA", "OBJETIVO"],
        runs.map((r) => [
          r.id.slice(0, 8),
          statusPt(r.status),
          names.get(r.botId) ?? r.botId.slice(0, 8),
          String(r.turns),
          formatUsd(r.costUsd),
          formatDateTime(r.createdAt),
          oneLine(r.objective, 50),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const showCommand: CommandSpec = {
  name: "show",
  summary:
    "Mostra o estado de uma execução: plano, resultado ou falha (com a origem), uso e tempos",
  options: {},
  positionals: { names: ["execução"] },
  notes: [
    "<execução> é o id ou o início dele.",
    "Para ver os eventos crus: suup inspect <execução>.",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const run = await findRun(db, ctx.args.positionals[0] as string);
    const bot = await getBot(db, run.botId);
    const events = await readEvents(db, run.id);
    const modelErrors = events.flatMap((e) => {
      const t = typedEvent(e);
      return t?.type === "model_error" ? [{ seq: e.seq, ...t.payload }] : [];
    });
    const versions = [
      ...new Set(
        events.flatMap((e) => {
          const t = typedEvent(e);
          return t?.type === "model_response" && (t.payload.purpose ?? "agent") === "agent"
            ? [t.payload.modelVersion]
            : [];
        }),
      ),
    ];
    const agentRequests = events.flatMap((e) => {
      const t = typedEvent(e);
      return t?.type === "model_request" && (t.payload.purpose ?? "agent") === "agent"
        ? [t.payload]
        : [];
    });
    const catalog = events.flatMap((e) => {
      const t = typedEvent(e);
      return t?.type === "tool_catalog" ? [t.payload] : [];
    })[0];
    const toolDefinitions = {
      mode: catalog?.mode ?? null,
      connectorTools: catalog?.connectorTools ?? 0,
      requests: agentRequests.length,
      lastRequest: agentRequests.at(-1)?.toolStats ?? null,
    };
    const lastQuestion = events
      .map((e) => typedEvent(e))
      .filter((t) => t?.type === "escalated")
      .at(-1);

    if (ctx.json) {
      ctx.out.data({
        ...runJson(run),
        bot:
          bot === null
            ? null
            : {
                id: bot.id,
                name: bot.name,
                modelId: bot.modelId,
                modelProvider: bot.modelProvider,
              },
        failure:
          run.failureOrigin === null
            ? null
            : {
                origin: run.failureOrigin,
                explanation: originExplanation(run.failureOrigin),
                detail: run.failureDetail,
              },
        modelErrors,
        modelVersions: versions,
        toolDefinitions,
        events: events.length,
        question: lastQuestion?.type === "escalated" ? lastQuestion.payload.question : null,
      });
      return EXIT_OK;
    }
    ctx.out.lines(
      describeRun(run, bot, {
        events: events.length,
        versions,
        modelErrors,
        toolDefinitions,
        question: lastQuestion?.type === "escalated" ? lastQuestion.payload.question : null,
      }),
    );
    return EXIT_OK;
  },
};

interface DescribeExtras {
  events: number;
  versions: string[];
  modelErrors: {
    seq: number;
    kind: string;
    message: string;
    attempt: number;
    retryable: boolean;
  }[];
  question: string | null;
  /** How the tools of connectors reached the model, and what the definitions of a request cost. */
  toolDefinitions: {
    mode: string | null;
    connectorTools: number;
    requests: number;
    lastRequest: {
      definitions: number;
      deferred: number;
      estimatedTokens: number;
      loadedTokens: number;
    } | null;
  };
}

export function describeRun(run: Run, bot: Bot | null, extra: DescribeExtras): string[] {
  const lines: string[] = [];
  lines.push(`Execução ${run.id}`);
  lines.push(`Situação: ${statusPt(run.status)} (${run.status})`);
  if (run.status === "failed" && run.failureOrigin !== null) {
    lines.push("");
    lines.push(`>>> FALHOU — ORIGEM: ${run.failureOrigin.toUpperCase()}`);
    lines.push(`    ${run.failureOrigin}: ${originExplanation(run.failureOrigin)}`);
    lines.push(`    Detalhe: ${run.failureDetail ?? "(sem detalhe)"}`);
    lines.push("");
  } else if (run.status === "cancelled") {
    lines.push("    Cancelada a pedido do usuário.");
  }
  lines.push(`Bot: ${bot === null ? run.botId : `${bot.name} (${bot.id})`}`);
  if (bot !== null)
    lines.push(
      `Modelo: ${bot.modelId} (provedor ${bot.modelProvider})${extra.versions.length > 0 ? ` — versão servida: ${extra.versions.join(", ")}` : ""}`,
    );
  lines.push(`Objetivo: ${run.objective}`);
  if (run.acceptanceCriteria.length > 0) {
    lines.push("Critérios de pronto:");
    for (const [i, c] of run.acceptanceCriteria.entries()) lines.push(`  ${i + 1}. ${c}`);
  }
  lines.push("Plano:");
  lines.push(...renderPlan(run.plan));
  const result = run.result as {
    summary?: string;
    evidence?: { criterion: string; evidence: string }[];
  } | null;
  if (result !== null && typeof result === "object" && typeof result.summary === "string") {
    lines.push("Resultado:");
    lines.push(...indent(result.summary, "  "));
    for (const item of result.evidence ?? []) {
      lines.push(`  - ${oneLine(item.criterion, 80)}: ${oneLine(item.evidence, 200)}`);
    }
  }
  if (run.status === "waiting_user" && extra.question !== null) {
    lines.push("Pergunta aguardando resposta:");
    lines.push(...indent(extra.question, "  "));
    lines.push(
      `Responda com: suup say ${run.id.slice(0, 8)} "<sua resposta>" e depois suup resume ${run.id.slice(0, 8)}`,
    );
  }
  if (extra.modelErrors.length > 0) {
    lines.push(`Erros do provedor (${extra.modelErrors.length}):`);
    for (const e of extra.modelErrors.slice(-5)) {
      lines.push(
        `  seq ${e.seq}: ${e.kind}, tentativa ${e.attempt}${e.retryable ? " (retentável)" : ""}: ${oneLine(e.message, 160)}`,
      );
    }
  }
  const defs = extra.toolDefinitions;
  if (defs.lastRequest !== null) {
    lines.push(
      `Definições de ferramentas por pedido: ${defs.lastRequest.definitions} (${defs.lastRequest.deferred} adiadas), ~${formatInt(defs.lastRequest.estimatedTokens)} tokens estimados, ~${formatInt(defs.lastRequest.loadedTokens)} no contexto${defs.mode === null ? "" : `; ferramentas de conectores: ${defs.connectorTools}, modo ${defs.mode}`}`,
    );
  }
  lines.push(
    `Uso: ${run.turns} turno${run.turns === 1 ? "" : "s"}, ${formatInt(run.inputTokens)} tokens de entrada, ${formatInt(run.outputTokens)} de saída, custo ${formatUsd(run.costUsd)}`,
  );
  lines.push("Tempos:");
  lines.push(`  criada em ${formatDateTime(run.createdAt)}`);
  if (run.startedAt !== null) lines.push(`  iniciada em ${formatDateTime(run.startedAt)}`);
  if (run.finishedAt !== null) {
    lines.push(
      `  terminou em ${formatDateTime(run.finishedAt)}${run.startedAt === null ? "" : ` (duração ${formatDuration(run.finishedAt.getTime() - run.startedAt.getTime())})`}`,
    );
  }
  lines.push(`Eventos gravados: ${extra.events} — veja com: suup inspect ${run.id.slice(0, 8)}`);
  return lines;
}
