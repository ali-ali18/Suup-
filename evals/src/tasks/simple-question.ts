import { check, eventsOf, finalSummary, result, statusCheck, workCalls } from "../kit.js";
import type { EvalTask } from "../types.js";

/** Counts the answer as right when it states 366 (a leap year has 366 days). */
const ANSWER = /\b366\b/;

/**
 * A question the bot can answer from what it knows. The harness rule being measured: a simple
 * question gets a plain-text answer, with no plan and no tools.
 */
export const simpleQuestion: EvalTask = {
  id: "simple-question",
  title: "Pergunta simples respondida direto, sem plano nem ferramentas",
  category: "simple",
  objective: "Quantos dias tem um ano bissexto? Responda direto, em uma frase.",
  criteria: ["A resposta informa corretamente o número de dias de um ano bissexto."],
  limits: { maxTurns: 4, maxCostUsd: 0.05, maxDurationMs: 60_000 },
  expect: { status: "done" },
  async setup() {},
  async reference() {},
  async verify(ctx) {
    const answer = finalSummary(ctx.events) ?? "";
    const plans = eventsOf(ctx.events, "plan_updated").length;
    return result([
      statusCheck(ctx, "done"),
      check("a resposta diz 366", ANSWER.test(answer), `resposta: ${JSON.stringify(answer)}`),
      check("nenhum plano foi criado", plans === 0, `${plans} atualização(ões) de plano`),
      check("no máximo 2 turnos", ctx.run.turns <= 2, `${ctx.run.turns} turno(s)`),
      check(
        "nenhuma ferramenta de trabalho foi usada",
        workCalls(ctx.events).length === 0,
        `${workCalls(ctx.events).length} chamada(s)`,
      ),
    ]);
  },
};
