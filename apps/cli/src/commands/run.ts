import { releaseRun } from "@suup/db";
import { DEFAULT_WORKER } from "@suup/runtime";
import { flag, list, str } from "../args.js";
import { type CommandSpec, warnIfLocalSandbox } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { followRun } from "../follow.js";
import { statusPt } from "../format.js";
import { findBot, findRun, readEvents } from "../lookup.js";
import { primedRenderState, renderEvent, renderPlan, typedEvent } from "../render.js";

export const runCommand: CommandSpec = {
  name: "run",
  summary: "Cria uma execução e a acompanha ao vivo (com um worker embutido neste processo)",
  options: {
    bot: {
      type: "string",
      value: "bot",
      help: "O bot que fará o trabalho: id, início do id ou nome (obrigatório)",
    },
    criterion: {
      type: "string",
      multiple: true,
      value: "texto",
      help: "Critério de pronto (repita a opção para vários)",
    },
    detach: {
      type: "boolean",
      help: "Só cria a execução e sai; um worker (suup worker) a processa depois",
    },
  },
  positionals: { names: ["objetivo"] },
  notes: [
    "Enquanto a execução trabalha, o que você digitar (num terminal) vai ao bot como mensagem, no próximo ponto seguro.",
    "Se o bot pergunta algo, a resposta é lida do terminal; sem terminal, use suup say e suup resume.",
    "Ctrl+C uma vez pausa no próximo ponto seguro (retome com suup resume); duas vezes aborta já.",
    'Exemplo: suup run "Crie o arquivo ola.txt com a palavra oi" --bot ajudante --criterion "ola.txt existe"',
  ],
  async run(ctx) {
    const objective = (ctx.args.positionals[0] as string).trim();
    const botRef = str(ctx.args, "bot");
    if (objective === "") throw new UsageError("O objetivo está vazio.", "run");
    if (botRef === undefined) throw new UsageError("Falta --bot <id ou nome do bot>.", "run");
    const criteria = list(ctx.args, "criterion").filter((c) => c.trim() !== "");

    const runtime = ctx.runtime();
    const bot = await findBot(runtime.db, botRef);
    const run = await runtime.createRun({ botId: bot.id, objective, acceptanceCriteria: criteria });

    if (flag(ctx.args, "detach")) {
      if (ctx.json) ctx.out.data({ id: run.id, status: run.status });
      else {
        ctx.out.line(`Execução criada: ${run.id} (bot ${bot.name}, na fila)`);
        ctx.out.line(
          `Um worker precisa processá-la: suup worker   ·   acompanhar: suup resume ${run.id.slice(0, 8)}   ·   estado: suup show ${run.id.slice(0, 8)}`,
        );
      }
      return EXIT_OK;
    }
    warnIfLocalSandbox(ctx);
    ctx.out.line(`Execução ${run.id} criada (bot ${bot.name}, modelo ${bot.modelId})`);
    return followRun(ctx, run.id, 0);
  },
};

export const resumeCommand: CommandSpec = {
  name: "resume",
  summary: "Continua e acompanha uma execução pausada, na fila ou aguardando você",
  options: {},
  positionals: { names: ["execução"] },
  notes: [
    "Funciona com execuções pausadas por Ctrl+C, devolvidas à fila ou respondidas com suup say.",
    "Uma execução que aguarda a sua resposta pede a resposta no terminal (ou use suup say antes).",
  ],
  async run(ctx) {
    const runtime = ctx.runtime();
    let run = await findRun(runtime.db, ctx.args.positionals[0] as string);
    const short = run.id.slice(0, 8);
    switch (run.status) {
      case "done":
      case "failed":
      case "cancelled":
        throw new CommandError(
          `A execução ${short} já terminou (${statusPt(run.status)}); não há o que retomar. Veja: suup show ${short}`,
        );
      case "waiting_approval":
        throw new CommandError("A execução espera uma aprovação, que ainda não existe na CLI.");
      case "running": {
        // Leased to a worker: either alive elsewhere, or dead with a lease that went stale.
        const staleMs = { ...DEFAULT_WORKER, ...runtime.config.worker }.staleAfterMs;
        const age =
          run.lockedAt === null ? Number.POSITIVE_INFINITY : Date.now() - run.lockedAt.getTime();
        if (age < staleMs) {
          throw new CommandError(
            `A execução ${short} está em andamento em outro processo (posse renovada há ${Math.round(age / 1000)} s por ${run.lockedBy ?? "?"}). Acompanhe com suup show ${short}.`,
          );
        }
        await releaseRun(runtime.db, run.id);
        ctx.out.line(
          "A posse da execução tinha vencido (o worker anterior parou); ela voltou para a fila.",
        );
        run = await findRun(runtime.db, run.id);
        break;
      }
      default:
        break;
    }

    ctx.out.line(`Retomando a execução ${run.id} (${statusPt(run.status)})`);
    ctx.out.line(`Objetivo: ${run.objective}`);
    ctx.out.line("Plano:");
    ctx.out.lines(renderPlan(run.plan));
    const events = await readEvents(runtime.db, run.id);
    if (run.status === "waiting_user") {
      const question = events.filter((e) => e.type === "escalated").at(-1);
      if (question !== undefined && typedEvent(question) !== undefined) {
        ctx.out.lines(renderEvent(question, primedRenderState(events)));
      }
    }
    warnIfLocalSandbox(ctx);
    return followRun(ctx, run.id, events.at(-1)?.seq ?? 0);
  },
};
