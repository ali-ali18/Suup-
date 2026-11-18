import { createInterface } from "node:readline";
import { getRun, postInbox } from "@suup/db";
import type { Ctx } from "./context.js";
import { EXIT_FAILED, EXIT_OK } from "./errors.js";
import { readEvents } from "./lookup.js";
import { primedRenderState, renderEvent, renderFooter } from "./render.js";

const POLL_MS = 120;
/** How long a soft stop waits for the current turn before it gives up (a second Ctrl+C aborts sooner). */
const SOFT_STOP_GRACE_MS = 10 * 60_000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Works on one run in this process (an embedded worker that only takes that run) and shows it
 * live by reading the event log, which is all the screen ever draws. Returns the exit code.
 *
 * - Lines typed while the run works (stdin must be a terminal) are posted to the run as user
 *   messages; when the run waits for an answer, the same is the answer.
 * - Ctrl+C once: soft stop (the run pauses at the next safe point and stays resumable). Twice:
 *   hard abort.
 * - Without a terminal, a run that waits for the user is left waiting, with instructions.
 */
export async function followRun(ctx: Ctx, runId: string, fromSeq: number): Promise<number> {
  const { io, out, json } = ctx;
  const runtime = ctx.runtime();
  const db = runtime.db;
  const short = runId.slice(0, 8);
  const interactive = io.stdin.isTTY === true && !json;
  const state = primedRenderState(
    fromSeq === 0 ? [] : (await readEvents(db, runId)).filter((e) => e.seq <= fromSeq),
  );
  let afterSeq = fromSeq;

  const emit = (events: Awaited<ReturnType<typeof readEvents>>) => {
    for (const event of events) {
      afterSeq = event.seq;
      if (json) {
        out.ndjson({
          type: "event",
          seq: event.seq,
          eventType: event.type,
          createdAt: event.createdAt.toISOString(),
          payload: event.payload,
        });
      } else {
        out.lines(renderEvent(event, state));
      }
    }
  };

  const worker = runtime.createWorker({
    workerId: `cli-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    onlyRunId: runId,
    concurrency: 1,
    idleBackoff: { minMs: 100, maxMs: 400 },
    onError: (error, context) => out.err(`worker: ${context}: ${message(error)}`),
  });

  let workerStopped = false;
  let presses = 0;
  let hardAborted = false;
  const requestStop = () => {
    void worker.stop({ graceMs: SOFT_STOP_GRACE_MS }).then(() => {
      workerStopped = true;
    });
  };
  const unsubscribe = io.onInterrupt(() => {
    presses += 1;
    if (presses === 1) {
      out.line("");
      out.line(
        "Ctrl+C: pausando no próximo ponto seguro (depois do turno atual). Ctrl+C de novo aborta já.",
      );
      requestStop();
    } else if (!hardAborted) {
      hardAborted = true;
      out.line(
        "Abortando agora: a chamada ao modelo e a ferramenta em andamento serão interrompidas.",
      );
      void worker.abortNow().then(() => {
        workerStopped = true;
      });
    }
  });

  const handleLine = async (line: string) => {
    const text = line.trim();
    if (text === "") return;
    try {
      const run = await getRun(db, runId);
      if (run === null || TERMINAL.has(run.status)) {
        out.line("A execução já terminou; a mensagem não foi enviada.");
        return;
      }
      const posted = await postInbox(db, runId, { kind: "user_message", text });
      out.line(
        posted.requeued
          ? "  (resposta enviada)"
          : "  (mensagem enviada: o bot a lê no próximo ponto seguro)",
      );
    } catch (error) {
      out.err(`Não foi possível enviar a mensagem: ${message(error)}`);
    }
  };
  const lines = interactive ? createInterface({ input: io.stdin }) : undefined;
  lines?.on("line", (line) => void handleLine(line));

  let prompted = false;
  worker.start();
  try {
    for (;;) {
      const run = await getRun(db, runId); // status first: its events are all in the log already
      if (run === null) {
        out.err(`A execução ${short} sumiu do banco.`);
        return EXIT_FAILED;
      }
      emit(await readEvents(db, runId, afterSeq));
      if (workerStopped || TERMINAL.has(run.status) || run.status === "waiting_approval") break;
      if (run.status === "waiting_user") {
        if (!interactive) break;
        if (!prompted) {
          out.raw("Sua resposta> ");
          prompted = true;
        }
      } else {
        prompted = false;
      }
      await sleep(POLL_MS);
    }
  } finally {
    unsubscribe();
    lines?.close();
    if (hardAborted) await worker.abortNow();
    else await worker.stop();
  }

  // Everything the worker wrote while stopping.
  emit(await readEvents(db, runId, afterSeq));
  const run = await getRun(db, runId);
  if (run === null) return EXIT_FAILED;
  const durationMs =
    run.finishedAt !== null && run.startedAt !== null
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
  if (json) {
    out.ndjson({
      type: "result",
      id: run.id,
      status: run.status,
      failureOrigin: run.failureOrigin,
      failureDetail: run.failureDetail,
      turns: run.turns,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
      paused: !TERMINAL.has(run.status) && run.status !== "waiting_user",
    });
  } else {
    if (interactive && prompted && run.status === "waiting_user") out.line("");
    out.lines(
      renderFooter({
        id: run.id,
        status: run.status,
        turns: run.turns,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
        durationMs,
      }),
    );
  }

  switch (run.status) {
    case "done":
      return EXIT_OK;
    case "failed":
    case "cancelled":
      out.line(`Detalhes: suup show ${short}   ·   linha do tempo: suup inspect ${short}`);
      return EXIT_FAILED;
    case "waiting_user":
      out.line(`A execução continua aguardando a sua resposta. Responda com:`);
      out.line(`  suup say ${short} "<sua resposta>"`);
      out.line(`  suup resume ${short}   (ou deixe um worker em execução continuar)`);
      return EXIT_OK;
    case "waiting_approval":
      out.line("A execução espera uma aprovação (ainda não há como aprovar pela CLI).");
      return EXIT_OK;
    default:
      out.line(
        `Execução pausada: o estado está guardado e nada se perdeu. Retome com: suup resume ${short}`,
      );
      if (hardAborted) {
        out.line(
          "Atenção: o abort interrompeu o que estava em andamento; o bot será avisado de que o resultado dessa ação é desconhecido.",
        );
        return EXIT_FAILED;
      }
      return EXIT_OK;
  }
}
