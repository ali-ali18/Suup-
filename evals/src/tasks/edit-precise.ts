import { check, linesOf, readText, result, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const FILE = "config.ini";

const ORIGINAL = `[servidor]
host = 127.0.0.1
porta = 8080
timeout = 30
# porta = 8080 (valor antigo, mantido para referência)

[cliente]
host = 127.0.0.1
porta = 8080
timeout = 30
porta_admin = 8080
`;

/** The same file with only the client's `porta` changed. */
const EXPECTED = ORIGINAL.replace(
  "[cliente]\nhost = 127.0.0.1\nporta = 8080",
  "[cliente]\nhost = 127.0.0.1\nporta = 9090",
);

/** Edit the right one of several near-identical lines. */
export const editPrecise: EvalTask = {
  id: "edit-precise",
  title: "Alterar só a ocorrência certa de uma linha quase repetida",
  category: "files",
  objective: `No arquivo ${FILE}, mude a "porta" da seção [cliente] para 9090. Não altere mais nada no arquivo: nenhuma outra linha, nenhum espaço, nenhum comentário.`,
  criteria: ["A porta da seção [cliente] é 9090.", "Nenhuma outra linha do arquivo foi alterada."],
  limits: { maxTurns: 12, maxCostUsd: 0.3, maxDurationMs: 180_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile(FILE, ORIGINAL);
  },
  async reference(ws) {
    await ws.writeFile(FILE, EXPECTED);
  },
  async verify(ctx) {
    const text = await readText(ctx.ws, FILE);
    const exact = text === EXPECTED;
    let detail: string | undefined;
    if (text === null) detail = "arquivo ausente";
    else if (!exact) {
      const got = linesOf(text);
      const want = linesOf(EXPECTED);
      const diffs: string[] = [];
      for (let i = 0; i < Math.max(got.length, want.length); i++) {
        if (got[i] !== want[i]) {
          diffs.push(
            `linha ${i + 1}: esperado ${JSON.stringify(want[i])}, obtido ${JSON.stringify(got[i])}`,
          );
        }
      }
      detail = diffs.slice(0, 4).join("; ");
    }
    return result([
      statusCheck(ctx, "done"),
      check("o arquivo é exatamente o esperado (só a linha certa mudou)", exact, detail),
    ]);
  },
};
