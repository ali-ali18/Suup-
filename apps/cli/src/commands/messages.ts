import { postInbox } from "@suup/db";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { findRun } from "../lookup.js";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export const sayCommand: CommandSpec = {
  name: "say",
  summary: "Envia uma mensagem a uma execução (também é como se responde a uma pergunta do bot)",
  options: {},
  positionals: { names: ["execução", "mensagem"] },
  notes: [
    "Em andamento: a mensagem entra no próximo ponto seguro, entre dois turnos.",
    "Aguardando você (o bot perguntou): a mensagem é a resposta e a execução volta para a fila;",
    "continue com: suup resume <execução> (ou deixe um worker em execução pegá-la).",
  ],
  async run(ctx) {
    const [ref, text] = ctx.args.positionals as [string, string];
    if (text.trim() === "") throw new UsageError("A mensagem está vazia.", "say");
    const db = ctx.runtime().db;
    const run = await findRun(db, ref);
    if (TERMINAL.has(run.status)) {
      throw new CommandError(
        `A execução ${run.id.slice(0, 8)} já terminou (${run.status}); não recebe mais mensagens. Crie outra com: suup run "<objetivo>" --bot <bot>`,
      );
    }
    if (run.status === "waiting_approval") {
      throw new CommandError("A execução espera uma aprovação, e uma mensagem não aprova nada.");
    }
    const posted = await postInbox(db, run.id, { kind: "user_message", text });
    if (ctx.json) {
      ctx.out.data({ runId: run.id, inboxId: posted.id, requeued: posted.requeued });
      return EXIT_OK;
    }
    if (posted.requeued) {
      ctx.out.line(
        `Resposta registrada. A execução voltou para a fila: continue com suup resume ${run.id.slice(0, 8)} (ou deixe um worker pegá-la).`,
      );
    } else {
      ctx.out.line("Mensagem registrada: o bot a lê no próximo ponto seguro (entre dois turnos).");
    }
    return EXIT_OK;
  },
};

export const stopCommand: CommandSpec = {
  name: "stop",
  summary: "Pede o cancelamento de uma execução",
  options: {},
  positionals: { names: ["execução"] },
  notes: [
    "O cancelamento é definitivo e acontece no próximo ponto seguro; precisa de um worker rodando",
    "(suup worker ou suup resume) para ser aplicado. Para só pausar uma execução que está sendo",
    "seguida neste terminal, use Ctrl+C: ela fica retomável com suup resume.",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const run = await findRun(db, ctx.args.positionals[0] as string);
    if (TERMINAL.has(run.status)) {
      throw new CommandError(`A execução ${run.id.slice(0, 8)} já terminou (${run.status}).`);
    }
    const posted = await postInbox(db, run.id, { kind: "stop" });
    if (ctx.json) ctx.out.data({ runId: run.id, inboxId: posted.id, requeued: posted.requeued });
    else {
      ctx.out.line(
        "Pedido de parada registrado: a execução é cancelada no próximo ponto seguro, quando um worker a processar.",
      );
    }
    return EXIT_OK;
  },
};
