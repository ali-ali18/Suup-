import { check, linesOf, readText, result, sha256, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const NUMBERS = [120, 85, 40, 255, 17, 63];

// The whole chain, computed here: every step feeds the next.
const p1 = NUMBERS.reduce((a, b) => a + b, 0);
const p2 = p1 * 3;
const p3 = sha256(String(p2)).slice(0, 8);
const codigo = `COD-${p3.toUpperCase()}-${p1}`;
const p5 = codigo.length;
const p6 = p5 + p2;
const p7 = p6 % 2 === 0 ? "PAR" : "IMPAR";

/** Each result file (path) and the value it must hold. */
const OUTPUTS: [path: string, value: string][] = [
  ["p1.txt", String(p1)],
  ["p2.txt", String(p2)],
  ["p3.txt", p3],
  ["saida/codigo.txt", codigo],
  ["p5.txt", String(p5)],
  ["p6.txt", String(p6)],
  ["p7.txt", p7],
];

const MANIFEST = [
  `passo1: ${p1}`,
  `passo2: ${p2}`,
  `passo3: ${p3}`,
  `passo4: ${codigo}`,
  `passo5: ${p5}`,
  `passo6: ${p6}`,
  `passo7: ${p7}`,
  "passo8: concluido",
];

const INSTRUCTIONS = `# Procedimento de fechamento

Execute os passos abaixo, em ordem. Cada passo usa o resultado do anterior.

Depois de cada passo, acrescente UMA linha ao final de \`manifesto.txt\` (crie o arquivo no passo 1), no formato \`passoN: valor\`, em que \`valor\` é exatamente o que o passo produziu. Os arquivos de resultado contêm só o valor, seguido de uma quebra de linha.

1. Some os números de \`entrada.txt\` (um por linha). Grave o total em \`p1.txt\`.
2. Multiplique o total do passo 1 por 3. Grave o resultado em \`p2.txt\`.
3. Calcule o SHA-256 do TEXTO do número do passo 2 (só os dígitos, sem quebra de linha) e grave em \`p3.txt\` os 8 primeiros caracteres hexadecimais, em minúsculas.
4. Crie \`saida/codigo.txt\` com o texto \`COD-<p3 em MAIÚSCULAS>-<total do passo 1>\` (por exemplo, \`COD-ABCD1234-99\`).
5. Conte os caracteres do texto de \`saida/codigo.txt\`, sem contar a quebra de linha final. Grave a contagem em \`p5.txt\`.
6. Some o valor do passo 5 ao valor do passo 2. Grave o resultado em \`p6.txt\`.
7. Se o valor do passo 6 for par, grave \`PAR\` em \`p7.txt\`; se for ímpar, grave \`IMPAR\`.
8. Acrescente ao manifesto a linha final \`passo8: concluido\`.
`;

/** An eight-step procedure where each step's output feeds the next: stays on track, or does not. */
export const longChecklist: EvalTask = {
  id: "long-checklist",
  title: "Seguir um procedimento de 8 passos encadeados e fechar o manifesto exato",
  category: "long",
  objective:
    "Execute o procedimento descrito em INSTRUCOES.md, seguindo os passos na ordem e registrando cada um no manifesto.txt como o arquivo manda.",
  criteria: [
    "Os 8 passos foram executados, cada um com o resultado correto.",
    "manifesto.txt tem uma linha por passo, na ordem, com o valor produzido.",
  ],
  limits: { maxTurns: 24, maxCostUsd: 1.0, maxDurationMs: 420_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile("INSTRUCOES.md", INSTRUCTIONS);
    await ws.writeFile("entrada.txt", `${NUMBERS.join("\n")}\n`);
  },
  async reference(ws) {
    for (const [path, value] of OUTPUTS) await ws.writeFile(path, `${value}\n`);
    await ws.writeFile("manifesto.txt", `${MANIFEST.join("\n")}\n`);
  },
  async verify(ctx) {
    const checks = [statusCheck(ctx, "done")];
    for (const [path, value] of OUTPUTS) {
      const text = await readText(ctx.ws, path);
      checks.push(
        check(
          `${path} contém ${value}`,
          text !== null && text.trim() === value,
          text === null ? "arquivo ausente" : `obtido ${JSON.stringify(text.trim())}`,
        ),
      );
    }
    const manifest = await readText(ctx.ws, "manifesto.txt");
    const lines = manifest === null ? [] : linesOf(manifest).map((l) => l.trim());
    const firstDiff = MANIFEST.findIndex((line, i) => lines[i] !== line);
    checks.push(
      check(
        "manifesto.txt é exatamente o esperado (8 linhas, em ordem)",
        manifest !== null && lines.length === MANIFEST.length && firstDiff === -1,
        manifest === null
          ? "arquivo ausente"
          : firstDiff === -1 && lines.length === MANIFEST.length
            ? undefined
            : `${lines.length} linha(s); primeira diferença na linha ${firstDiff === -1 ? lines.length + 1 : firstDiff + 1}: esperado ${JSON.stringify(MANIFEST[firstDiff === -1 ? lines.length : firstDiff])}, obtido ${JSON.stringify(lines[firstDiff === -1 ? lines.length : firstDiff])}`,
      ),
    );
    return result(checks);
  },
};
