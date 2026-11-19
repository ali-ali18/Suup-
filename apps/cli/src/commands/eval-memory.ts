import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb, type Db, migrate } from "@suup/db";
import {
  CONSOLIDATION_CASES,
  formatConsolidationReport,
  formatRecallReport,
  runConsolidationEval,
  runRecallBenchmark,
} from "@suup/evals";
import { resolveDatabaseUrl } from "@suup/runtime";
import { flag, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatUsd } from "../format.js";

const DEFAULT_BUDGET_USD = 0.5;

/**
 * A database of its own for an evaluation: a new schema in the configured database, migrated, and
 * dropped afterwards. An evaluation writes bots, conversations and memories; none of it may reach
 * the user's real data.
 */
async function withScratchDb<T>(ctx: Ctx, work: (db: Db) => Promise<T>): Promise<T> {
  const runtime = ctx.runtime();
  const { config } = ctx.config();
  const url = resolveDatabaseUrl(config, ctx.io.env);
  if (url === undefined)
    throw new CommandError("Nenhum banco de dados configurado (DATABASE_URL).");
  const schema = `eval_memory_${randomBytes(5).toString("hex")}`;
  await runtime.db.sql.unsafe(`create schema ${schema}`);
  const scratch = createDb(url, { schema });
  try {
    await migrate(scratch);
    return await work(scratch);
  } finally {
    await scratch.close();
    await runtime.db.sql.unsafe(`drop schema if exists ${schema} cascade`);
  }
}

export const evalMemoryRecall: CommandSpec = {
  name: "eval memory-recall",
  summary:
    "Mede se a busca por palavras acha o item certo nos 5 primeiros, com e sem o fato curto (não gasta)",
  options: {
    out: {
      type: "string",
      value: "arquivo",
      help: "Grava o resultado completo, em JSON, neste arquivo",
    },
  },
  positionals: { names: [] },
  notes: [
    "Usa uma memória inventada (28 notas, 10 entradas de diário, 8 conversas) e 20 perguntas. Não chama modelo: mede só a busca do banco (recall e search_conversations).",
    "Roda num esquema temporário do banco configurado, que é apagado no fim.",
  ],
  async run(ctx) {
    const report = await withScratchDb(ctx, (db) => runRecallBenchmark(db));
    const outPath = str(ctx.args, "out");
    if (outPath !== undefined)
      await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
    if (ctx.json) {
      ctx.out.data(report);
      return EXIT_OK;
    }
    ctx.out.line(formatRecallReport(report));
    return EXIT_OK;
  },
};

export const evalMemory: CommandSpec = {
  name: "eval memory",
  summary:
    "Roda a consolidação da memória com o modelo barato em conversas inventadas e mostra o que ele propôs (gasta dinheiro)",
  options: {
    model: {
      type: "string",
      value: "modelo",
      help: "Modelo da configuração (padrão: o da consolidação da memória)",
    },
    "budget-usd": {
      type: "string",
      value: "US$",
      help: `Teto de gasto (padrão ${DEFAULT_BUDGET_USD})`,
    },
    out: {
      type: "string",
      value: "arquivo",
      help: "Grava o resultado completo, em JSON, neste arquivo",
    },
    yes: { type: "boolean", help: "Confirma que pode gastar até o teto" },
  },
  positionals: { names: [] },
  notes: [
    `${CONSOLIDATION_CASES.length} conversas inventadas passam pelo caminho real da consolidação (pedido, resposta forçada, checagens, gravação), num esquema temporário do banco.`,
    "Confere sozinho só as garantias do harness (citação literal numa mensagem sua, regra e perfil pendentes, o valor proibido fora da memória); o resto é para uma pessoa ler no relatório.",
  ],
  async run(ctx) {
    const runtime = ctx.runtime();
    const status = runtime.memoryReviewerStatus();
    const modelId = str(ctx.args, "model") ?? status.model ?? undefined;
    if (modelId === undefined) {
      throw new CommandError(
        `Nenhum modelo para a memória: ${status.reason ?? "configure memory.consolidation.model"}, ou passe --model.`,
      );
    }
    const { model } = runtime.resolveModel(modelId);
    const key = runtime.keyStatus(model.provider);
    if (!key.ok)
      throw new CommandError(`O provedor "${model.provider}" não está pronto: ${key.reason}.`);
    const raw = str(ctx.args, "budget-usd");
    const budget = raw === undefined ? DEFAULT_BUDGET_USD : Number(raw.replace(",", "."));
    if (!Number.isFinite(budget) || !(budget > 0)) {
      throw new UsageError(
        `--budget-usd precisa de um número maior que zero (recebido ${JSON.stringify(raw)}).`,
        "eval memory",
      );
    }
    ctx.out.line(
      `Consolidação: ${CONSOLIDATION_CASES.length} conversas, modelo ${model.id}, teto ${formatUsd(budget)}.`,
    );
    if (!flag(ctx.args, "yes")) {
      throw new CommandError("Isto gasta dinheiro. Confira o plano acima e repita com --yes.");
    }
    const provider = runtime.getProvider(model.provider);
    const report = await withScratchDb(ctx, (db) =>
      runConsolidationEval({
        db,
        provider,
        model: {
          id: model.id,
          maxOutputTokens: model.maxOutputTokens,
          pricing: model.pricing,
          supportsForcedToolChoice: model.supportsForcedToolChoice,
        },
        budgetUsd: budget,
        onCase: (result, spent) => {
          if (!ctx.json)
            ctx.out.line(`  ${result.id}: ${result.status} · ${formatUsd(spent)} até agora`);
        },
      }),
    );
    const outPath = str(ctx.args, "out");
    if (outPath !== undefined)
      await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
    if (ctx.json) {
      ctx.out.data(report);
      return EXIT_OK;
    }
    ctx.out.line(formatConsolidationReport(report));
    return report.invariantsHold ? EXIT_OK : 1;
  },
};
