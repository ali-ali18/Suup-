import { check, exists, result, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";
import { diffHashes, expectedHashes, hashesOf, runVerifier, seedBundle } from "./kit.js";
import { DRIFT_HIDDEN, DRIFT_REFERENCE, DRIFT_SEED } from "./seeds/spec-drift.js";

/** The stale implementation (written from the first three documents only), for the self-check. */
export { DRIFT_REFERENCE, DRIFT_STALE } from "./seeds/spec-drift.js";

/** The groups of hidden cases: the rules the amendments leave alone, and one per amendment. */
export const DRIFT_GROUPS: Record<string, string> = {
  base: "regras que nenhuma emenda alterou",
  E1: "emenda 1 (json: total como texto com 2 casas)",
  E2: "emenda 2 (linha inválida é ignorada com aviso)",
  E3: "emenda 3 (ordem padrão por total)",
  E4: "emenda 4 (--minimo vale para itens)",
  E5: "emenda 5 (rodapé com a contagem de categorias)",
};

interface HiddenOutput {
  falhas: Record<string, string[]>;
  casos: Record<string, number>;
  total: number;
}

/**
 * A small CLI specified across four documents, the last of which amends the earlier ones in five
 * places. A bot that reads the last file once, or never, or implements the base and "patches"
 * from memory, fails the amendment it forgot; one that rewrites an untouched rule while applying an
 * amendment fails the base group.
 */
export const specDrift: EvalTask = {
  id: "spec-drift",
  title:
    "Implementar uma ferramenta de linha de comando a partir de 4 documentos, o último com 5 emendas",
  category: "code",
  objective:
    "Implemente a ferramenta agrupar.py (Python 3, só a biblioteca padrão) na raiz da sua pasta de trabalho, conforme a especificação dos 4 documentos de spec/ (01-base.md, 02-formatos.md, 03-erros.md e 04-emendas.md). " +
    "As emendas de 04-emendas.md prevalecem sobre os outros documentos; onde elas não falam, valem os outros. " +
    "Há um arquivo de exemplo, vendas-exemplo.csv. Confira o que fizer rodando a ferramenta você mesmo; não altere os arquivos de spec/.",
  criteria: [
    "agrupar.py existe e cumpre a especificação: as regras dos documentos base, de formatos e de erros que as emendas não alteraram.",
    "Cada uma das 5 emendas está aplicada onde substitui ou acrescenta ao que estava nos outros documentos.",
  ],
  limits: { maxTurns: 70, maxCostUsd: 0.8, maxDurationMs: 1_200_000 },
  expect: { status: "done" },
  async setup(ws) {
    await seedBundle(ws, DRIFT_SEED);
  },
  async reference(ws) {
    await ws.writeFile("agrupar.py", DRIFT_REFERENCE);
  },
  async verify(ctx) {
    const { ws } = ctx;
    const checks = [statusCheck(ctx, "done")];
    const present = await exists(ws, "agrupar.py");
    checks.push(check("agrupar.py existe", present));

    const run = present
      ? await runVerifier(ws, "drift", DRIFT_HIDDEN, [], 180_000)
      : { exitCode: null, stdout: "", stderr: "" };
    let output: HiddenOutput | null = null;
    try {
      output = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as HiddenOutput;
    } catch {
      output = null;
    }
    for (const [tag, name] of Object.entries(DRIFT_GROUPS)) {
      const failures = output?.falhas[tag];
      const cases = output?.casos[tag] ?? 0;
      checks.push(
        check(
          `${name} (${cases} casos)`,
          output !== null && failures !== undefined && failures.length === 0 && cases > 0,
          output === null
            ? `a verificação não rodou: ${(run.stderr || run.stdout).trim().slice(-200)}`
            : (failures ?? []).join(" | "),
        ),
      );
    }

    const drift = diffHashes(await hashesOf(ws, ["spec"]), expectedHashes(DRIFT_SEED, ["spec"]));
    checks.push(check("os arquivos de spec/ não foram alterados", drift === "", drift));
    return result(checks, { casosOcultos: output?.total ?? 0 });
  },
};
