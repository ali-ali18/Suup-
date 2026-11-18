import {
  acceptedFinishSeq,
  check,
  linesOf,
  readsFrom,
  readText,
  result,
  statusCheck,
  toolCalls,
  writesTo,
} from "../kit.js";
import type { EvalTask } from "../types.js";

const FILE = "saudacao.txt";
const EXPECTED = ["Olá, mundo!", "Suup está pronto."];

/**
 * Create a file with exact content. The harness rule being measured: verify instead of assuming.
 * The log must show the file being read back or checked after the last write and before `finish`.
 */
export const writeAndVerify: EvalTask = {
  id: "write-and-verify",
  title: "Criar um arquivo com conteúdo exato e conferi-lo antes de concluir",
  category: "files",
  objective: `Crie o arquivo ${FILE} com exatamente duas linhas: na primeira, "${EXPECTED[0]}"; na segunda, "${EXPECTED[1]}". Sem linhas em branco extras e sem espaços sobrando.`,
  criteria: [
    `${FILE} existe com exatamente o conteúdo pedido.`,
    "O conteúdo do arquivo foi conferido depois de escrito.",
  ],
  limits: { maxTurns: 12, maxCostUsd: 0.3, maxDurationMs: 180_000 },
  expect: { status: "done" },
  async setup() {},
  async reference(ws) {
    await ws.writeFile(FILE, `${EXPECTED.join("\n")}\n`);
  },
  async verify(ctx) {
    const text = await readText(ctx.ws, FILE);
    const lines = text === null ? null : linesOf(text);
    const contentOk =
      lines !== null &&
      lines.length === EXPECTED.length &&
      lines.every((l, i) => l === EXPECTED[i]);

    const calls = toolCalls(ctx.events).filter((c) => c.result?.isError !== true);
    const finishSeq = acceptedFinishSeq(ctx.events) ?? Number.POSITIVE_INFINITY;
    const writes = calls.filter((c) => c.seq < finishSeq && writesTo(c, FILE));
    const lastWrite = writes.at(-1);
    // A shell call that writes and then shows the file in one command counts as a check too.
    const readBack =
      lastWrite !== undefined &&
      calls.some(
        (c) =>
          c.seq < finishSeq &&
          readsFrom(c, FILE) &&
          (c.seq > lastWrite.seq || (c.seq === lastWrite.seq && c.name === "shell")),
      );
    return result([
      statusCheck(ctx, "done"),
      check(
        `${FILE} tem o conteúdo exato`,
        contentOk,
        text === null ? "arquivo ausente" : JSON.stringify(text),
      ),
      check(
        "o arquivo foi lido de volta (ou conferido) depois da última escrita e antes de concluir",
        readBack,
        lastWrite === undefined
          ? "nenhuma escrita no log"
          : `última escrita no evento ${lastWrite.seq}`,
      ),
    ]);
  },
};
