import { cancelRun, postInbox } from "@suup/db";
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
    "Se a pergunta tem opções, a resposta que é exatamente o número de uma opção (1, 2...) vale a opção;",
    "qualquer outro texto vai como foi escrito.",
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
    if (run.status === "waiting_timer") {
      ctx.out.line(
        `Mensagem registrada: o retorno agendado foi cancelado e a execução voltou para a fila (suup resume ${run.id.slice(0, 8)}, ou deixe um worker pegá-la).`,
      );
    } else if (posted.requeued) {
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
    "O cancelamento é definitivo. Uma execução que ainda está na fila e nunca começou é cancelada",
    "na hora; as outras são canceladas no próximo ponto seguro, e isso precisa de um worker rodando",
    "(suup worker ou suup resume) para ser aplicado. Para só pausar uma execução que está sendo",
    "seguida neste terminal, use Ctrl+C: ela fica retomável com suup resume.",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const run = await findRun(db, ctx.args.positionals[0] as string);
    if (TERMINAL.has(run.status)) {
      throw new CommandError(`A execução ${run.id.slice(0, 8)} já terminou (${run.status}).`);
    }
    if (run.status === "waiting_timer") {
      // Parked for a return of its own: nobody holds it, so it is cancelled right here (the
      // pending return is cancelled in the log).
      await cancelRun(db, run.id);
      if (ctx.json) ctx.out.data({ runId: run.id, cancelled: true });
      else ctx.out.line(`Execução ${run.id.slice(0, 8)} cancelada: estava parada até o retorno.`);
      return EXIT_OK;
    }
    if (run.status === "queued") {
      // Nobody holds it: a run that never started is cancelled right here; one that has a log is
      // left to the loop (a worker), and the message says so.
      const after = await cancelRun(db, run.id);
      if (after.status === "cancelled") {
        if (ctx.json) ctx.out.data({ runId: run.id, cancelled: true });
        else
          ctx.out.line(`Execução ${run.id.slice(0, 8)} cancelada: estava na fila e nunca começou.`);
        return EXIT_OK;
      }
      if (ctx.json) ctx.out.data({ runId: run.id, cancelled: false, queued: true });
      else {
        ctx.out.line(
          `Pedido de parada registrado, mas a execução ${run.id.slice(0, 8)} está na fila com histórico: só é cancelada quando um worker a pegar. Se nenhum estiver rodando, ela fica na fila (suup doctor aponta); rode suup worker ou suup resume ${run.id.slice(0, 8)} para aplicar.`,
        );
      }
      return EXIT_OK;
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
