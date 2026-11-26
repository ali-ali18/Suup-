import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CHAT_TASK_CASES,
  type ChatTaskReport,
  type ChatTaskVariant,
  formatChatTaskReport,
  runChatTasks,
  stamp,
} from "@suup/evals";
import { createRuntime, type RuntimeConfig } from "@suup/runtime";
import { flag, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatUsd } from "../format.js";

const DEFAULT_BUDGET_USD = 0.6;
const COMMAND = "eval chat-tasks";

/** A positive amount in dollars, with a dot or a comma: read by the number's own syntax, not a pattern. */
function dollars(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET_USD;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new UsageError(
      `--budget-usd precisa de um número maior que zero, em dólares (recebido ${JSON.stringify(raw)}).`,
      COMMAND,
    );
  }
  return value;
}

function variantsOf(raw: string | undefined): ChatTaskVariant[] {
  const value = raw ?? "ab";
  if (value === "a" || value === "b") return [value];
  if (value === "ab") return ["a", "b"];
  throw new UsageError(`--variant aceita a, b ou ab (recebido ${JSON.stringify(raw)}).`, COMMAND);
}

/** The configuration of a variant: A has neither harness check, B has both. */
function variantConfig(
  config: RuntimeConfig,
  variant: ChatTaskVariant,
  checkModel: string | undefined,
): RuntimeConfig {
  const on = variant === "b";
  return {
    ...config,
    defaults: {
      ...config.defaults,
      tasks: {
        handoff: { ...config.defaults?.tasks?.handoff, enabled: on },
        askCheck: {
          ...config.defaults?.tasks?.askCheck,
          enabled: on,
          ...(checkModel === undefined ? {} : { model: checkModel }),
        },
      },
    },
  };
}

export const evalChatTasks: CommandSpec = {
  name: COMMAND,
  summary: "Mede se o bot passa trabalho longo para uma tarefa sozinho (gasta dinheiro)",
  options: {
    model: { type: "string", value: "modelo", help: "Modelo da configuração para os bots (obrigatório)" },
    variant: {
      type: "string",
      value: "a|b|ab",
      help: "A: só o prompt; B: prompt, freio cedo e conferência no fim (padrão ab)",
    },
    "check-model": {
      type: "string",
      value: "modelo",
      help: "Modelo da conferência no fim, na variante B (padrão: o da configuração)",
    },
    "budget-usd": {
      type: "string",
      value: "US$",
      help: `Teto de gasto somando as variantes, dividido igualmente (padrão ${DEFAULT_BUDGET_USD})`,
    },
    out: { type: "string", value: "arquivo", help: "Grava o resultado completo, em JSON, neste arquivo" },
    yes: { type: "boolean", help: "Confirma que o eval pode gastar até o teto" },
  },
  positionals: { names: [] },
  notes: [
    `São ${CHAT_TASK_CASES.length} casos em quatro grupos: rápidos (responder no chat), longos (virar tarefa, quase todos no terminal), vários pedidos numa mensagem (uma tarefa por pedido longo) e seguimento (repassar à tarefa aberta).`,
    "Cada caso cria um bot novo com as ferramentas do terminal e de arquivos liberadas, roda só o turno do chat, conta as tarefas abertas e cancela todas no fim. Nenhuma tarefa é executada.",
    "Precisa de sandbox local (os casos escrevem as pastas que citam) e do banco da configuração.",
  ],
  async run(ctx) {
    const modelId = str(ctx.args, "model");
    if (modelId === undefined) throw new UsageError("Passe --model com um modelo da configuração.", COMMAND);
    const variants = variantsOf(str(ctx.args, "variant"));
    const checkModel = str(ctx.args, "check-model");
    const budgetUsd = dollars(str(ctx.args, "budget-usd"));
    const { config, baseDir } = ctx.config();
    if (config.sandbox.kind !== "local") {
      throw new CommandError("Este eval precisa de sandbox local (sandbox.kind = \"local\").");
    }
    const machineRoot = isAbsolute(config.sandbox.root)
      ? config.sandbox.root
      : resolve(baseDir, config.sandbox.root);
    const probe = ctx.runtime();
    const { model } = probe.resolveModel(modelId);
    const key = probe.keyStatus(model.provider);
    if (!key.ok) throw new CommandError(`O provedor "${model.provider}" não está pronto: ${key.reason}.`);
    if (model.pricing === undefined) {
      throw new CommandError(`Sem preço configurado para ${model.id}: o teto de gasto não valeria.`);
    }
    const perVariant = budgetUsd / variants.length;
    ctx.out.line(
      `Chat ou tarefa: ${CHAT_TASK_CASES.length} casos, variante(s) ${variants.join(" e ").toUpperCase()}, modelo ${model.id}, teto ${formatUsd(budgetUsd)} (${formatUsd(perVariant)} por variante).`,
    );
    if (!flag(ctx.args, "yes")) {
      throw new CommandError("Este eval gasta dinheiro. Confira o plano acima e repita com --yes.");
    }
    const folder = `chat-tasks/${stamp(new Date())}`;
    const reports: ChatTaskReport[] = [];
    for (const variant of variants) {
      const runtime = createRuntime(variantConfig(config, variant, checkModel), {
        env: ctx.io.env,
        baseDir,
        log: (message) => ctx.out.err(message),
      });
      try {
        const report = await runChatTasks({
          runtime,
          variant,
          modelId,
          machineRoot,
          folder: `${folder}/${variant}`,
          budgetUsd: perVariant,
          onCase(result, spent) {
            if (ctx.json) return;
            ctx.out.line(
              `  ${variant.toUpperCase()} ${result.id}: ${result.passed ? "ok" : `ERRO (${result.why})`} · ${formatUsd(spent)} até agora`,
            );
          },
        });
        reports.push(report);
      } finally {
        await runtime.close();
      }
    }
    const outPath = str(ctx.args, "out");
    if (outPath !== undefined) {
      await writeFile(resolve(outPath), `${JSON.stringify(reports, null, 2)}\n`);
    }
    if (ctx.json) {
      ctx.out.data(reports);
      return EXIT_OK;
    }
    for (const report of reports) ctx.out.lines(formatChatTaskReport(report));
    return EXIT_OK;
  },
};
