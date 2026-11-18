import { check, readText, result, sha256, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const FILES: Record<string, string> = {
  "app/precos.py": `"""Cálculos de preço."""

DESCONTOS = {"basico": 0, "prata": 5, "ouro": 10}


def calc_total(itens, plano="basico"):
    """Soma preço * quantidade dos itens e aplica o desconto do plano (em %)."""
    bruto = sum(item["preco"] * item["qtd"] for item in itens)
    return round(bruto * (100 - DESCONTOS[plano]) / 100, 2)


def recalc_total_com_frete(itens, plano, frete):
    """A mesma conta, mais o frete. É outra função, com outro nome."""
    return round(calc_total(itens, plano) + frete, 2)
`,
  "app/carrinho.py": `from precos import calc_total, recalc_total_com_frete


class Carrinho:
    def __init__(self, plano):
        self.plano = plano
        self.itens = []

    def adicionar(self, nome, preco, qtd):
        self.itens.append({"nome": nome, "preco": preco, "qtd": qtd})

    def total(self):
        return calc_total(self.itens, self.plano)

    def total_com_frete(self, frete):
        return recalc_total_com_frete(self.itens, self.plano, frete)
`,
  "app/relatorio.py": `import json

from precos import calc_total

# NÃO renomear: esta string é o nome da coluna nos arquivos de histórico já gravados.
COLUNA_LEGADA = "calc_total"


def resumo(carrinho, caminho_historico):
    with open(caminho_historico, encoding="utf-8") as arquivo:
        historico = json.load(arquivo)
    anterior = historico[-1][COLUNA_LEGADA]
    atual = calc_total(carrinho.itens, carrinho.plano)
    return {"anterior": anterior, "atual": atual, "variacao": round(atual - anterior, 2)}
`,
  "app/main.py": `from carrinho import Carrinho
from relatorio import resumo


def main():
    carrinho = Carrinho("ouro")
    carrinho.adicionar("caneta", 2.5, 10)
    carrinho.adicionar("caderno", 18.9, 3)
    print("total:", carrinho.total())
    print("com frete:", carrinho.total_com_frete(12.0))
    print("resumo:", resumo(carrinho, "app/historico.json"))


main()
`,
  "app/historico.json": `[
  {"mes": "2024-03", "calc_total": 61.0},
  {"mes": "2024-04", "calc_total": 70.5}
]
`,
};

const HISTORY = "app/historico.json";
const OUTPUT =
  "total: 73.53\ncom frete: 85.53\nresumo: {'anterior': 70.5, 'atual': 73.53, 'variacao': 3.03}\n";

/** Whole-word counts in the seed: 7 uses of the old name (6 identifiers + 1 protected string). */
const NEW_NAME_COUNT = 6;
const UNRELATED_NAME_COUNT = 3;

const WORD = (name: string) => `grep -rhow ${name} app --include=*.py | wc -l`;

async function count(ws: Parameters<EvalTask["verify"]>[0]["ws"], name: string): Promise<number> {
  const out = await ws.exec(WORD(name), { timeoutMs: 30_000 });
  return Number(out.stdout.trim());
}

/** The solution: rename every identifier, keep the string that names a legacy column. */
function renamed(text: string): string {
  // The one string occurrence is the only one followed by a closing quote.
  return text.replace(/\bcalc_total\b(?!")/g, "calcular_total");
}

/** Rename a function across four files without touching a string that is data, nor a lookalike. */
export const multiFileRefactor: EvalTask = {
  id: "multi-file-refactor",
  title: "Renomear uma função em 4 arquivos sem mexer na string de dados nem em nomes parecidos",
  category: "code",
  objective:
    "No código Python da pasta app/, renomeie a função calc_total para calcular_total: a definição e todos os lugares que a usam. " +
    "O programa precisa continuar funcionando e imprimindo exatamente a mesma saída de antes (`python3 app/main.py`). " +
    "Não renomeie nada além dessa função.",
  criteria: [
    "calc_total não existe mais como nome de função: a definição e todas as chamadas usam calcular_total.",
    "python3 app/main.py imprime a mesma saída de antes.",
    "Nenhuma outra coisa foi renomeada.",
  ],
  limits: { maxTurns: 18, maxCostUsd: 0.75, maxDurationMs: 300_000 },
  expect: { status: "done" },
  async setup(ws) {
    for (const [path, content] of Object.entries(FILES)) await ws.writeFile(path, content);
  },
  async reference(ws) {
    for (const [path, content] of Object.entries(FILES)) {
      if (path.endsWith(".py")) await ws.writeFile(path, renamed(content));
    }
  },
  async verify(ctx) {
    const { ws } = ctx;
    const run = await ws.exec("PYTHONDONTWRITEBYTECODE=1 python3 app/main.py", {
      timeoutMs: 60_000,
    });
    const history = await readText(ws, HISTORY);
    const precos = await readText(ws, "app/precos.py");
    const oldCount = await count(ws, "calc_total");
    const newCount = await count(ws, "calcular_total");
    const unrelated = await count(ws, "recalc_total_com_frete");
    const relatorio = await readText(ws, "app/relatorio.py");
    return result([
      statusCheck(ctx, "done"),
      check(
        "o programa roda e imprime a mesma saída",
        run.exitCode === 0 && run.stdout === OUTPUT,
        run.exitCode === 0
          ? `saída: ${JSON.stringify(run.stdout)}`
          : `código ${run.exitCode ?? "nenhum"}: ${run.stderr.trim().split("\n").at(-1) ?? ""}`,
      ),
      check(
        "calcular_total é definida e usada nos 6 lugares esperados",
        newCount === NEW_NAME_COUNT && (precos ?? "").includes("def calcular_total("),
        `${newCount} ocorrência(s) de calcular_total (esperado ${NEW_NAME_COUNT})`,
      ),
      check(
        'só resta calc_total na string "calc_total" (nome de coluna legada)',
        oldCount === 1 && (relatorio ?? "").includes('COLUNA_LEGADA = "calc_total"'),
        `${oldCount} ocorrência(s) de calc_total (esperado 1, a string)`,
      ),
      check(
        "recalc_total_com_frete continua com o nome original",
        unrelated === UNRELATED_NAME_COUNT,
        `${unrelated} ocorrência(s) (esperado ${UNRELATED_NAME_COUNT})`,
      ),
      check(
        "historico.json não foi alterado",
        history !== null && sha256(history) === sha256(FILES[HISTORY] ?? ""),
        history === null ? "arquivo ausente" : "o conteúdo mudou",
      ),
    ]);
  },
};
