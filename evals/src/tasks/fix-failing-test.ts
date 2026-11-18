import { check, readText, result, runPython, sha256, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const MODULE = `"""Divisão de valores em parcelas."""


def parcelar(total_centavos, n):
    """Divide \`total_centavos\` em \`n\` parcelas inteiras.

    A soma das parcelas é exatamente \`total_centavos\`; as parcelas diferem em no máximo
    1 centavo e as maiores vêm primeiro. Levanta ValueError se \`n\` for menor que 1 ou se
    \`total_centavos\` for negativo.
    """
    if n < 1 or total_centavos < 0:
        raise ValueError("parâmetros inválidos")
    base = total_centavos // n
    return [base] * n
`;

const FIXED_MODULE = MODULE.replace(
  "    base = total_centavos // n\n    return [base] * n\n",
  "    base, resto = divmod(total_centavos, n)\n    return [base + 1] * resto + [base] * (n - resto)\n",
);

const TESTS = `import unittest

from fatura import parcelar


class TestParcelar(unittest.TestCase):
    def test_divisao_exata(self):
        self.assertEqual(parcelar(100, 4), [25, 25, 25, 25])

    def test_com_resto(self):
        self.assertEqual(parcelar(100, 3), [34, 33, 33])

    def test_parcela_unica(self):
        self.assertEqual(parcelar(990, 1), [990])

    def test_numero_de_parcelas_invalido(self):
        with self.assertRaises(ValueError):
            parcelar(100, 0)


if __name__ == "__main__":
    unittest.main()
`;

const TESTS_HASH = sha256(TESTS);

/** Cases the visible tests do not cover: they catch a fix that special-cases the test input. */
const HIDDEN = `
import json
from fatura import parcelar
casos = [(101, 4, [26, 25, 25, 25]), (5, 7, [1, 1, 1, 1, 1, 0, 0]), (0, 3, [0, 0, 0]),
         (10, 3, [4, 3, 3]), (7, 2, [4, 3]), (1000, 6, [167, 167, 167, 167, 166, 166])]
erros = []
for total, n, esperado in casos:
    obtido = parcelar(total, n)
    if obtido != esperado:
        erros.append(f"parcelar({total}, {n}) = {obtido}, esperado {esperado}")
for total in range(0, 60):
    for n in range(1, 12):
        p = parcelar(total, n)
        if len(p) != n or sum(p) != total or max(p) - min(p) > 1 or p != sorted(p, reverse=True):
            erros.append(f"invariantes violadas em parcelar({total}, {n}) = {p}")
            break
try:
    parcelar(-1, 3)
    erros.append("parcelar(-1, 3) deveria levantar ValueError")
except ValueError:
    pass
print(json.dumps(erros[:5]))
raise SystemExit(1 if erros else 0)
`;

/** The classic: a failing unit test, a bug to find, and a test file that must stay untouched. */
export const fixFailingTest: EvalTask = {
  id: "fix-failing-test",
  title: "Corrigir um bug de verdade (sem mexer no teste) em um módulo Python",
  category: "code",
  objective:
    "O teste test_fatura.py está falhando. Corrija o defeito em fatura.py de modo que o comportamento descrito na documentação da função seja respeitado. " +
    "Não altere test_fatura.py. Rode os testes com `python3 -m unittest` para conferir.",
  criteria: [
    "Todos os testes de test_fatura.py passam.",
    "test_fatura.py não foi modificado.",
    "O defeito foi corrigido na lógica, e não contornado para o caso do teste.",
  ],
  limits: { maxTurns: 16, maxCostUsd: 0.6, maxDurationMs: 300_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile("fatura.py", MODULE);
    await ws.writeFile("test_fatura.py", TESTS);
  },
  async reference(ws) {
    await ws.writeFile("fatura.py", FIXED_MODULE);
  },
  async verify(ctx) {
    const tests = await readText(ctx.ws, "test_fatura.py");
    const unittest = await ctx.ws.exec("python3 -m unittest -q test_fatura 2>&1", {
      timeoutMs: 60_000,
    });
    const hidden = await runPython(ctx.ws, HIDDEN);
    const hiddenDetail = (hidden.stdout.trim() || hidden.stderr.trim()).slice(0, 400);
    return result([
      statusCheck(ctx, "done"),
      check(
        "test_fatura.py não foi modificado",
        tests !== null && sha256(tests) === TESTS_HASH,
        tests === null ? "arquivo ausente" : "o hash mudou",
      ),
      check(
        "os testes visíveis passam",
        unittest.exitCode === 0,
        `código de saída ${unittest.exitCode ?? "nenhum"}: ${unittest.stdout.trim().slice(-300)}`,
      ),
      check(
        "casos ocultos e invariantes passam (a correção não é um caso especial)",
        hidden.exitCode === 0,
        hiddenDetail,
      ),
    ]);
  },
};
