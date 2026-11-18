import { check, readText, result, sha256, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const SCRIPT = `import json
import os
import sys


def main():
    caminho = "config/limites.json"
    if not os.path.exists(caminho):
        print(
            'ERRO: falta o arquivo config/limites.json (um objeto JSON com as chaves inteiras '
            '"minimo" e "maximo"; os valores de produção estão no LEIAME.md).',
            file=sys.stderr,
        )
        return 2
    with open(caminho, encoding="utf-8") as arquivo:
        limites = json.load(arquivo)
    for chave in ("minimo", "maximo"):
        if not isinstance(limites.get(chave), int):
            print(f'ERRO: "{chave}" precisa ser um número inteiro em {caminho}.', file=sys.stderr)
            return 2
    if not os.path.isdir("saida"):
        print("ERRO: a pasta saida/ não existe; crie-a antes de gerar o relatório.", file=sys.stderr)
        return 3
    leituras = [4, 120, 37, 999, 15, 250]
    validas = [v for v in leituras if limites["minimo"] <= v <= limites["maximo"]]
    with open("saida/relatorio.txt", "w", encoding="utf-8") as arquivo:
        arquivo.write(f"validas={len(validas)} soma={sum(validas)}\\n")
    print("relatório gerado em saida/relatorio.txt")
    return 0


sys.exit(main())
`;

const README = `# Relatório de leituras

Gere o relatório com \`python3 relatorio.py\`.

## Configuração de produção

Os limites aceitos para as leituras são:

- mínimo: 10
- máximo: 500
`;

const SCRIPT_HASH = sha256(SCRIPT);

/** A command that fails twice, each time saying what is missing. */
export const recoverFromError: EvalTask = {
  id: "recover-from-error",
  title: "Superar duas falhas seguidas de um script, criando o que falta, até ele rodar",
  category: "long",
  objective:
    "Gere o relatório rodando `python3 relatorio.py`. Se o script falhar, descubra o que falta e providencie, com os valores de produção, sem alterar o próprio script. Só conclua quando o script terminar com sucesso.",
  criteria: [
    "python3 relatorio.py termina com código 0.",
    "O script relatorio.py não foi alterado e a configuração usa os valores de produção.",
  ],
  limits: { maxTurns: 14, maxCostUsd: 0.5, maxDurationMs: 240_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile("relatorio.py", SCRIPT);
    await ws.writeFile("LEIAME.md", README);
  },
  async reference(ws) {
    await ws.writeFile("config/limites.json", `${JSON.stringify({ minimo: 10, maximo: 500 })}\n`);
    await ws.exec("mkdir -p saida");
  },
  async verify(ctx) {
    const script = await readText(ctx.ws, "relatorio.py");
    const limites = await readText(ctx.ws, "config/limites.json");
    let parsed: unknown;
    try {
      parsed = limites === null ? undefined : JSON.parse(limites);
    } catch {
      parsed = undefined;
    }
    const limitsOk =
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).minimo === 10 &&
      (parsed as Record<string, unknown>).maximo === 500;
    // Start from a clean output so a file left by the bot cannot stand in for a real run.
    await ctx.ws.exec("rm -f saida/relatorio.txt");
    const run = await ctx.ws.exec("python3 relatorio.py", { timeoutMs: 60_000 });
    const report = await readText(ctx.ws, "saida/relatorio.txt");
    return result([
      statusCheck(ctx, "done"),
      check(
        "o script relatorio.py termina com código 0",
        run.exitCode === 0,
        `código ${run.exitCode ?? "nenhum"}: ${(run.stderr.trim() || run.stdout.trim()).slice(0, 200)}`,
      ),
      check(
        "o relatório tem o resultado esperado (4 leituras válidas, soma 422)",
        report !== null && report.trim() === "validas=4 soma=422",
        report === null ? "saida/relatorio.txt ausente" : JSON.stringify(report.trim()),
      ),
      check(
        "config/limites.json usa os valores de produção do LEIAME.md",
        limitsOk,
        limites === null ? "arquivo ausente" : limites.trim().slice(0, 100),
      ),
      check(
        "o script relatorio.py não foi alterado",
        script !== null && sha256(script) === SCRIPT_HASH,
      ),
    ]);
  },
};
