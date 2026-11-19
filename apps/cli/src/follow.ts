import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { escalatedQuestions } from "@suup/core";
import { getRun, postInbox, type Run } from "@suup/db";
import { pendingCards, printCards } from "./approval-prompt.js";
import type { Ctx } from "./context.js";
import { CommandError, EXIT_FAILED, EXIT_OK } from "./errors.js";
import { readEvents } from "./lookup.js";
import { needsQuestionnaire, Questionnaire } from "./questionnaire.js";
import { primedRenderState, type RawEvent, renderEvent, renderFooter } from "./render.js";
import { isReallyWaiting } from "./waiting.js";

const POLL_MS = 120;
/** How long a soft stop waits for the current turn before it gives up (a second Ctrl+C aborts sooner). */
const SOFT_STOP_GRACE_MS = 10 * 60_000;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Something typed lines can be taken from: while it is attached, every line goes to `handler`. */
export interface LineSource {
  attach(handler: (line: string) => void): () => void;
}

/**
 * The lines typed on a terminal: one reader for a whole session, so several follows (and the
 * prompt between them) share it. A line typed while nobody listens waits for `next`.
 */
export class LineQueue implements LineSource {
  readonly #rl;
  readonly #waiting: string[] = [];
  #handler: ((line: string) => void) | undefined;
  #waiter: ((line: string | null) => void) | undefined;
  #closed = false;

  constructor(input: Readable) {
    this.#rl = createInterface({ input });
    this.#rl.on("line", (line) => {
      if (this.#handler !== undefined) this.#handler(line);
      else if (this.#waiter !== undefined) {
        const resolve = this.#waiter;
        this.#waiter = undefined;
        resolve(line);
      } else this.#waiting.push(line);
    });
    this.#rl.on("close", () => {
      this.#closed = true;
      this.#waiter?.(null);
      this.#waiter = undefined;
    });
  }

  attach(handler: (line: string) => void): () => void {
    this.#handler = handler;
    for (const line of this.#waiting.splice(0)) handler(line);
    return () => {
      if (this.#handler === handler) this.#handler = undefined;
    };
  }

  /** The next typed line, or `null` when the input ended. */
  next(): Promise<string | null> {
    const queued = this.#waiting.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  close(): void {
    this.#rl.close();
  }
}

export interface FollowOptions {
  /** Sends a typed line. Default: posts it to the run's inbox as a user message. */
  onLine?(text: string, run: Run): Promise<void>;
  /** Where typed lines come from. Default: a reader of stdin made (and closed) by the follow. */
  lines?: LineSource;
  /** Called when the run starts waiting for an answer, just before the prompt is shown. */
  beforePrompt?(): Promise<void>;
  /** Events the live view leaves out (the chat shows the outcome as the bot's message). */
  hide?(event: RawEvent): boolean;
}

export interface FollowResult {
  run: Run;
  hardAborted: boolean;
  /** The "Sua resposta>" prompt was shown and the answer has not been typed. */
  prompted: boolean;
  durationMs: number | null;
}

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
export async function followRunCore(
  ctx: Ctx,
  runId: string,
  fromSeq: number,
  options: FollowOptions = {},
): Promise<FollowResult> {
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
      const hidden = options.hide?.(event) === true;
      if (json) {
        out.ndjson({
          type: "event",
          seq: event.seq,
          eventType: event.type,
          createdAt: event.createdAt.toISOString(),
          payload: event.payload,
        });
      } else {
        // Hidden events still go through the renderer, which keeps its turn counter and call names.
        const lines = renderEvent(event, state);
        if (!hidden) out.lines(lines);
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

  // A question with choices is answered one line per question; the answer becomes plain text.
  let questionnaire: Questionnaire | undefined;
  const handleLine = async (line: string) => {
    let text = line.trim();
    if (questionnaire !== undefined) {
      const step = questionnaire.answer(line);
      if (!step.done) {
        if (step.message !== undefined) out.line(step.message);
        out.raw(step.prompt);
        return;
      }
      questionnaire = undefined;
      text = step.text;
    }
    if (text === "") return;
    try {
      const run = await getRun(db, runId);
      if (run === null || TERMINAL.has(run.status)) {
        out.line("A execução já terminou; a mensagem não foi enviada.");
        return;
      }
      if (options.onLine !== undefined) {
        await options.onLine(text, run);
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
  const ownLines = interactive && options.lines === undefined ? new LineQueue(io.stdin) : undefined;
  const source = options.lines ?? ownLines;
  const detach = interactive ? source?.attach((line) => void handleLine(line)) : undefined;

  let prompted = false;
  worker.start();
  try {
    for (;;) {
      const run = await getRun(db, runId); // status first: its events are all in the log already
      if (run === null) throw new CommandError(`A execução ${short} sumiu do banco.`);
      emit(await readEvents(db, runId, afterSeq));
      if (workerStopped || TERMINAL.has(run.status)) break;
      // Esperar de verdade é haver algo pendente: um cartão sem decisão ou uma pergunta sem
      // resposta no log (`waiting.ts`). Uma linha com status de espera sem isso é o instante em que
      // uma execução retomada é recolocada onde o log está, antes de absorver a resposta que ele já
      // tem (alguns milissegundos, mais numa máquina ocupada): o worker está prestes a seguir.
      const waitingLog =
        run.status === "waiting_user" || run.status === "waiting_approval"
          ? await readEvents(db, runId)
          : [];
      const cards = run.status === "waiting_approval" ? (await pendingCards(db, runId)).length : 0;
      if (isReallyWaiting(run.status, waitingLog, cards)) {
        if (run.status === "waiting_approval") break;
        if (!interactive) break;
        if (!prompted) {
          await options.beforePrompt?.();
          const log = waitingLog;
          const secret = log
            .filter((e) => e.type === "escalated" || e.type === "secret_requested")
            .at(-1);
          if (secret?.type === "secret_requested") {
            const name = (secret.payload as { name?: string }).name ?? "?";
            out.line(
              `O bot pediu o segredo ${name}. Guarde-o sem passar pelo chat: suup vault set ${name} --run ${short}   (ou responda aqui para recusar).`,
            );
          }
          const asked = log.filter((e) => e.type === "escalated").at(-1);
          const questions =
            asked === undefined
              ? []
              : escalatedQuestions(asked.payload as Parameters<typeof escalatedQuestions>[0]);
          if (needsQuestionnaire(questions)) {
            questionnaire = new Questionnaire(questions);
            out.raw(questionnaire.prompt());
          } else {
            out.raw("Sua resposta> ");
          }
          prompted = true;
        }
      } else if (run.status === "waiting_user" || run.status === "waiting_approval") {
        // A transição acima: nada pendente ainda; só espera o laço seguir.
      } else {
        prompted = false;
        questionnaire = undefined;
      }
      await sleep(POLL_MS);
    }
  } finally {
    unsubscribe();
    detach?.();
    ownLines?.close();
    if (hardAborted) await worker.abortNow();
    else await worker.stop();
  }

  // Everything the worker wrote while stopping.
  emit(await readEvents(db, runId, afterSeq));
  const run = await getRun(db, runId);
  if (run === null) throw new CommandError(`A execução ${short} sumiu do banco.`);
  const durationMs =
    run.finishedAt !== null && run.startedAt !== null
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
  return { run, hardAborted, prompted, durationMs };
}

/** Follows a run to where it stops and says how it ended. Returns the exit code. */
export async function followRun(ctx: Ctx, runId: string, fromSeq: number): Promise<number> {
  const { io, out, json } = ctx;
  const short = runId.slice(0, 8);
  const interactive = io.stdin.isTTY === true && !json;
  let result: FollowResult;
  try {
    result = await followRunCore(ctx, runId, fromSeq);
  } catch (error) {
    if (error instanceof CommandError) {
      out.err(error.message);
      return EXIT_FAILED;
    }
    throw error;
  }
  const { run, hardAborted, prompted, durationMs } = result;
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
    case "waiting_approval": {
      out.line("A execução espera a sua aprovação:");
      printCards(ctx, await pendingCards(ctx.runtime().db, run.id));
      out.line(`Depois de decidir, a execução volta à fila: suup resume ${short}`);
      return EXIT_OK;
    }
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
