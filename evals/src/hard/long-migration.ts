import { check, result, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";
import {
  diffHashes,
  expectedHashes,
  hashesOf,
  parseUnittest,
  runVerifier,
  seedBundle,
} from "./kit.js";
import { MIGRATION_HIDDEN, MIGRATION_REFERENCE, MIGRATION_SEED } from "./seeds/long-migration.js";

/** The two tests that fail before and after the migration (listed in CONHECIDOS.md). */
export const KNOWN_FAILURES = [
  "tests.test_pedidos.TestFrete.test_frete_regiao_norte",
  "tests.test_relatorio.TestExportacao.test_exporta_para_o_volume_externo",
];
const TESTS_TOTAL = 15;

/** What each of the ten rules of MIGRACAO.md is, for the names of the checks. */
export const MIGRATION_RULES: Record<number, string> = {
  1: "moeda: formatar de nucleo.dinheiro",
  2: "imposto: alíquota como fração, só por nome",
  3: "registros: Registro.novo(tipo=, nome=)",
  4: "busca: Resultado com .ok em vez de KeyError",
  5: 'datas: formato="br" explícito',
  6: 'arredondamento: modo="cima" em toda chamada',
  7: "eventos: um dict com nome e dados",
  8: "status: enum Status e status.name",
  9: "configuração: config.obter(...)",
  10: "erros: ErroDeNegocio com os códigos",
};

const PROTECTED = ["nucleo", "tests"];

/**
 * A long, mechanical migration that rewards diligence: ten rules, each with several call sites in
 * different files, two of them silent (no error says the call is wrong), and two tests that fail
 * for reasons that have nothing to do with the migration and must be left alone.
 */
export const longMigration: EvalTask = {
  id: "long-migration",
  title: "Migrar um projeto Python por uma mudança de API com 10 regras, sem mexer nos testes",
  category: "long",
  objective:
    "O pacote nucleo/ deste projeto foi atualizado para a versão 2 e o pacote app/ ainda usa a API antiga, por isso nem importa. " +
    "Siga as 10 regras do arquivo MIGRACAO.md e migre todo o app/, sem mudar o comportamento que o app tinha. " +
    "Não altere nucleo/ nem os arquivos de tests/. Leia também o CONHECIDOS.md antes de olhar as falhas dos testes. " +
    "Confira com `python3 -m unittest discover -s tests -t .`.",
  criteria: [
    "Todas as 10 regras do MIGRACAO.md foram aplicadas em todos os pontos do app/ (há regras que não geram erro quando esquecidas).",
    "nucleo/ e tests/ não foram alterados.",
    "Os testes que passam hoje na v2 passam; os dois testes listados em CONHECIDOS.md continuam falhando como estavam, sem serem consertados.",
  ],
  limits: { maxTurns: 80, maxCostUsd: 0.8, maxDurationMs: 1_200_000 },
  expect: { status: "done" },
  async setup(ws) {
    await seedBundle(ws, MIGRATION_SEED);
  },
  async reference(ws) {
    await seedBundle(ws, MIGRATION_REFERENCE);
  },
  async verify(ctx) {
    const { ws } = ctx;
    const checks = [statusCheck(ctx, "done")];

    const hashes = await hashesOf(ws, PROTECTED);
    const drift = diffHashes(hashes, expectedHashes(MIGRATION_SEED, PROTECTED));
    checks.push(
      check(
        "nucleo/ e tests/ não foram alterados (nem recebidos arquivos a mais)",
        drift === "",
        drift,
      ),
    );

    const unit = await ws.exec("python3 -m unittest discover -s tests -t . -v 2>&1", {
      timeoutMs: 120_000,
    });
    const outcomes = parseUnittest(unit.stdout);
    const failing = Object.entries(outcomes)
      .filter(([, o]) => o === "FAIL" || o === "ERROR")
      .map(([name]) => name)
      .sort();
    checks.push(
      check(
        `os ${TESTS_TOTAL} testes rodam`,
        Object.keys(outcomes).length === TESTS_TOTAL,
        `${Object.keys(outcomes).length} testes encontrados: ${unit.stdout.trim().slice(-200)}`,
      ),
    );
    checks.push(
      check(
        "só as falhas conhecidas (CONHECIDOS.md) continuam falhando",
        JSON.stringify(failing) === JSON.stringify([...KNOWN_FAILURES].sort()),
        `falhando: ${failing.join(", ") || "nenhum"}`,
      ),
    );

    const hidden = await runVerifier(ws, "migration", MIGRATION_HIDDEN);
    let perRule: Record<string, string[]> = {};
    try {
      perRule = JSON.parse(hidden.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
        string,
        string[]
      >;
    } catch {
      perRule = {};
    }
    for (const [n, name] of Object.entries(MIGRATION_RULES)) {
      const problems = perRule[n];
      checks.push(
        check(
          `regra ${n} (${name})`,
          problems !== undefined && problems.length === 0,
          problems === undefined
            ? `a verificação não rodou: ${(hidden.stderr || hidden.stdout).trim().slice(-200)}`
            : problems.join(" | "),
        ),
      );
    }
    return result(checks);
  },
};
