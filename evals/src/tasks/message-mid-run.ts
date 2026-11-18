import {
  CONTROL_TOOLS,
  check,
  eventsOf,
  readText,
  result,
  statusCheck,
  toolCalls,
} from "../kit.js";
import type { EvalTask } from "../types.js";

const NUMBERS = [1, 2, 3, 4, 5];
const CUBES = NUMBERS.map((n) => n ** 3);
const TOTAL = CUBES.reduce((a, b) => a + b, 0);

/** A requirement changes after the first tool result: the final result must follow the change. */
export const messageMidRun: EvalTask = {
  id: "message-mid-run",
  title: "Uma mensagem do usuário no meio do trabalho muda um requisito; o resultado deve segui-la",
  category: "judgment",
  objective:
    "Faça, em quatro etapas: (1) crie a pasta lote/ com os arquivos item1.txt a item5.txt, em que itemN.txt contém o QUADRADO de N (só o número); " +
    "(2) crie lote/total.txt com a soma dos cinco números; (3) crie lote/LEIA.txt com a frase `Lote concluído`; (4) confira os arquivos.",
  criteria: [
    "Os arquivos item1.txt a item5.txt, o total.txt e o LEIA.txt existem em lote/ com o conteúdo pedido, já considerando qualquer mudança que o usuário tenha enviado.",
  ],
  limits: { maxTurns: 14, maxCostUsd: 0.5, maxDurationMs: 240_000 },
  expect: { status: "done" },
  inboxScript: [
    {
      // After the first tool result of a working tool (not `plan`).
      afterEvent: (event, log) => {
        if (event.type !== "tool_result") return false;
        const work = toolCalls(log).filter((c) => !CONTROL_TOOLS.has(c.name));
        return work.length > 0 && work[0]?.result?.seq === event.seq;
      },
      item: {
        kind: "user_message",
        text: "Mudança de requisito: em vez do quadrado, cada itemN.txt deve conter o CUBO de N (1, 8, 27, 64, 125), e o total.txt deve ser a soma dos cubos. O resto continua igual.",
      },
    },
  ],
  async setup() {},
  async reference(ws) {
    for (const n of NUMBERS) await ws.writeFile(`lote/item${n}.txt`, `${n ** 3}\n`);
    await ws.writeFile("lote/total.txt", `${TOTAL}\n`);
    await ws.writeFile("lote/LEIA.txt", "Lote concluído\n");
  },
  async verify(ctx) {
    const checks = [statusCheck(ctx, "done")];
    const delivered = eventsOf(ctx.events, "user_message").length;
    checks.push(
      check(
        "a mensagem do usuário foi entregue ao bot no meio do trabalho",
        delivered >= 1,
        `${delivered} mensagem(ns) entregue(s)`,
      ),
    );
    for (const n of NUMBERS) {
      const text = await readText(ctx.ws, `lote/item${n}.txt`);
      const want = String(n ** 3);
      checks.push(
        check(
          `lote/item${n}.txt contém ${want} (o cubo, não o quadrado)`,
          text !== null && text.trim() === want,
          text === null ? "arquivo ausente" : `obtido ${JSON.stringify(text.trim())}`,
        ),
      );
    }
    const total = await readText(ctx.ws, "lote/total.txt");
    checks.push(
      check(
        `lote/total.txt contém ${TOTAL} (a soma dos cubos)`,
        total !== null && total.trim() === String(TOTAL),
        total === null ? "arquivo ausente" : `obtido ${JSON.stringify(total.trim())}`,
      ),
    );
    const leia = await readText(ctx.ws, "lote/LEIA.txt");
    checks.push(
      check(
        "lote/LEIA.txt contém `Lote concluído` (parte que não mudou)",
        leia !== null && leia.trim() === "Lote concluído",
        leia === null ? "arquivo ausente" : `obtido ${JSON.stringify(leia.trim())}`,
      ),
    );
    return result(checks);
  },
};
