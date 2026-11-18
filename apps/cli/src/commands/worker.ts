import type { RunEnd } from "@suup/core";
import { reconcileRunEffects } from "@suup/runtime";
import { posInt } from "../args.js";
import { type CommandSpec, warnIfLocalSandbox } from "../context.js";
import { EXIT_OK } from "../errors.js";
import { formatDuration, statusPt } from "../format.js";

const SOFT_STOP_GRACE_MS = 30_000;

function describeEnd(end: RunEnd): string {
  const id = end.runId.slice(0, 8);
  switch (end.outcome) {
    case "settled":
      return `Execução ${id}: ${statusPt(end.status)} em ${formatDuration(end.durationMs)}`;
    case "released":
      return end.reason === "shutdown"
        ? `Execução ${id}: pausada e devolvida à fila (retome com suup resume ${id})`
        : `Execução ${id}: ${end.reason === "interrupt" ? "interrompida" : "pausada"} a pedido do usuário; fica parada até ser retomada (suup resume ${id} ou o app)`;
    case "failed":
      return `Execução ${id}: falhou fora do caminho do modelo e das ferramentas (origem harness): ${end.error instanceof Error ? end.error.message : String(end.error)}`;
    case "lease_lost":
      return `Execução ${id}: outro worker assumiu a posse; este largou a execução`;
  }
}

export const workerCommand: CommandSpec = {
  name: "worker",
  summary: "Roda um worker: pega execuções da fila até receber SIGINT ou SIGTERM",
  options: {
    concurrency: {
      type: "string",
      value: "N",
      help: "Execuções ao mesmo tempo (padrão: da configuração, ou 4)",
    },
  },
  positionals: { names: [] },
  notes: [
    "Ctrl+C (ou SIGTERM) uma vez: para de pegar execuções novas e leva as atuais até o próximo ponto seguro,",
    "devolvendo-as à fila (esperando até 30 s). Uma segunda vez aborta já.",
  ],
  async run(ctx) {
    const concurrency = posInt(ctx.args, "concurrency", "worker");
    const runtime = ctx.runtime();
    warnIfLocalSandbox(ctx);
    const worker = runtime.createWorker({
      ...(concurrency === undefined ? {} : { concurrency }),
      onRunEnd: (end) => {
        if (ctx.json)
          ctx.out.ndjson({
            type: "run_end",
            ...end,
            error: end.outcome === "failed" ? String(end.error) : undefined,
          });
        else ctx.out.line(describeEnd(end));
      },
      onError: (error, context) =>
        ctx.out.err(
          `worker: ${context}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    // Runs that ended while no worker was looking (a crash) still owe the conversation and the diary.
    const caught = await reconcileRunEffects(runtime.db);
    if (caught.length > 0) {
      ctx.out.line(
        `Pendências de execuções que terminaram sem aviso: ${caught.length} acertada(s).`,
      );
    }
    worker.start();
    ctx.out.line(`Worker ${worker.workerId} pronto. Ctrl+C para parar com calma.`);

    await new Promise<void>((resolve) => {
      let presses = 0;
      const unsubscribe = ctx.io.onInterrupt(() => {
        presses += 1;
        if (presses === 1) {
          ctx.out.line(
            "Parando: as execuções atuais vão até o próximo ponto seguro e voltam para a fila (Ctrl+C de novo aborta já).",
          );
          void worker.stop({ graceMs: SOFT_STOP_GRACE_MS }).then(() => {
            unsubscribe();
            resolve();
          });
        } else {
          void worker.abortNow();
        }
      });
    });
    ctx.out.line("Worker parado.");
    return EXIT_OK;
  },
};
