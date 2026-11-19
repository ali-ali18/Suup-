import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createModelReviewer } from "@suup/core";
import { BATTERY, formatBatteryReport, runBattery } from "@suup/evals";
import { flag, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatUsd } from "../format.js";

const DEFAULT_BUDGET_USD = 0.5;

/** A positive amount in dollars, with a dot or a comma: read by the number's own syntax, not a pattern. */
function dollars(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET_USD;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new UsageError(
      `--budget-usd precisa de um número maior que zero, em dólares (recebido ${JSON.stringify(raw)}).`,
      "eval approvals",
    );
  }
  return value;
}

export const evalApprovals: CommandSpec = {
  name: "eval approvals",
  summary: "Mede o auto-review com uma bateria fixa de chamadas plantadas (gasta dinheiro)",
  options: {
    model: {
      type: "string",
      value: "modelo",
      help: "Modelo da configuração que revisa (padrão: o do auto-review)",
    },
    "budget-usd": {
      type: "string",
      value: "US$",
      help: `Teto de gasto; a bateria para quando chega nele (padrão ${DEFAULT_BUDGET_USD})`,
    },
    out: {
      type: "string",
      value: "arquivo",
      help: "Grava o resultado completo, em JSON, neste arquivo",
    },
    yes: { type: "boolean", help: "Confirma que a bateria pode gastar até o teto" },
  },
  positionals: { names: [] },
  notes: [
    `A bateria tem ${BATTERY.length} chamadas em três classes: (a) arriscadas, (b) as mesmas com texto de atacante nos argumentos, (c) benignas parecidas com as arriscadas. Cada uma passa pelo caminho real: o portão, o revisor por modelo e as checagens do harness.`,
    "Mede, por classe: as que passaram quando não deviam (a, b), os pedidos de confirmação que não deviam existir (c) e o custo. Nada é ajustado para dar certo.",
    "Usa o provedor e a chave da configuração (apiKeyEnv) e as regras de exemplo da bateria, não as suas.",
  ],
  async run(ctx) {
    const runtime = ctx.runtime();
    const status = runtime.autoReviewStatus();
    const modelId = str(ctx.args, "model") ?? status.model ?? undefined;
    if (modelId === undefined) {
      throw new CommandError(
        `Nenhum modelo para revisar: ${status.reason ?? "configure approvals.autoReview.model"}, ou passe --model.`,
      );
    }
    const { model } = runtime.resolveModel(modelId);
    const key = runtime.keyStatus(model.provider);
    if (!key.ok)
      throw new CommandError(`O provedor "${model.provider}" não está pronto: ${key.reason}.`);
    const budgetUsd = dollars(str(ctx.args, "budget-usd"));
    ctx.out.line(
      `Bateria do auto-review: ${BATTERY.length} chamadas, modelo ${model.id}, teto ${formatUsd(budgetUsd)}.`,
    );
    if (model.pricing === undefined) {
      ctx.out.line(
        `ATENÇÃO: sem preço configurado para ${model.id}: o custo não será medido e o teto não vale.`,
      );
    }
    if (!flag(ctx.args, "yes")) {
      throw new CommandError(
        "Esta bateria gasta dinheiro. Confira o plano acima e repita com --yes.",
      );
    }
    const reviewer = createModelReviewer({
      provider: runtime.getProvider(model.provider),
      model: {
        id: model.id,
        maxOutputTokens: model.maxOutputTokens,
        pricing: model.pricing,
        supportsForcedToolChoice: model.supportsForcedToolChoice,
      },
    });
    const report = await runBattery({
      reviewer,
      model: model.id,
      budgetUsd,
      onCase(result, spent) {
        if (ctx.json) return;
        ctx.out.line(
          `  ${result.id}: ${result.wrong ? "ERRO" : "ok"} (${result.outcome}) · ${formatUsd(spent)} até agora`,
        );
      },
    });
    const outPath = str(ctx.args, "out");
    if (outPath !== undefined) {
      await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (ctx.json) {
      ctx.out.data(report);
      return EXIT_OK;
    }
    ctx.out.lines(formatBatteryReport(report));
    return EXIT_OK;
  },
};
