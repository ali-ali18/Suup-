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
import { Rng, seedBundle } from "./kit.js";

const PRODUCTS = [
  "parafuso",
  "porca",
  "arruela",
  "cabo",
  "tomada",
  "lampada",
  "fita",
  "cola",
  "tinta",
  "pincel",
  "serra",
  "martelo",
];

interface Row {
  codigo: string;
  produto: string;
  valor: number;
}

/** The raw input: 24 valid rows (with ties and stray spaces) and 3 invalid ones. */
function buildInput(): { csv: string; valid: Row[] } {
  const rng = new Rng(7_021);
  const valid: Row[] = [];
  const lines = ["codigo,produto,valor_centavos"];
  const shared = [1_250, 4_800, 7_300]; // values that appear in more than one row (ties)
  for (let i = 1; i <= 24; i++) {
    const row: Row = {
      codigo: `P-${String(i * 7 + (i % 3)).padStart(3, "0")}`,
      produto: `${PRODUCTS[i % PRODUCTS.length]} ${String.fromCharCode(64 + (i % 9) + 1)}`,
      valor: i % 6 === 0 ? (shared[(i / 6 - 1) % 3] as number) : rng.between(300, 9_000),
    };
    valid.push(row);
  }
  // A tie that only the code can break, and one pair of equal values at the 8/9 border.
  (valid[2] as Row).valor = 1_250;
  (valid[14] as Row).valor = 4_800;
  const dirty = ["P-900,etiqueta,n/d", "P-901,rolo,", "  P-902 , caixa , 12.5"];
  const all: string[] = [];
  valid.forEach((r, i) => {
    const spaced =
      i % 4 === 0
        ? `  ${r.codigo} , ${r.produto} , ${r.valor} `
        : `${r.codigo},${r.produto},${r.valor}`;
    all.push(spaced);
    if (i === 5) all.push(dirty[0] as string);
    if (i === 12) all.push(dirty[1] as string);
    if (i === 19) all.push(dirty[2] as string);
  });
  lines.push(...all);
  return { csv: `${lines.join("\n")}\n`, valid };
}

const csvLines = (header: string, rows: string[][]) =>
  `${[header, ...rows.map((r) => r.join(","))].join("\n")}\n`;

/** All twelve files of the pipeline, in the order the bot must use (`asc` first, `desc` after the message). */
export function pipeline(order: "asc" | "desc"): Record<string, string> {
  const { valid } = buildInput();
  const dir = order === "asc" ? 1 : -1;
  const cmp = (a: Row, b: Row) =>
    a.valor !== b.valor
      ? dir * (a.valor - b.valor)
      : a.codigo < b.codigo
        ? -1
        : a.codigo > b.codigo
          ? 1
          : 0;
  const clean = [...valid];
  const sorted = [...valid].sort(cmp);
  const n = sorted.length;
  const faixaOf = (pos: number) => (pos <= n / 3 ? "A" : pos <= (2 * n) / 3 ? "B" : "C");
  const ranked = sorted.map((r, i) => ({ ...r, pos: i + 1, faixa: faixaOf(i + 1) }));
  const total = sorted.reduce((s, r) => s + r.valor, 0);
  const sumOf = (f: string) => ranked.filter((r) => r.faixa === f).reduce((s, r) => s + r.valor, 0);
  const p10 = Math.floor((sumOf("A") * 2000 + total) / (2 * total));
  const pct = `${Math.floor(p10 / 10)}.${p10 % 10}%`;
  let running = 0;

  const files: Record<string, string> = {
    "build/01-limpo.csv": csvLines(
      "codigo,produto,valor_centavos",
      clean.map((r) => [r.codigo, r.produto, String(r.valor)]),
    ),
    "build/02-ordenado.csv": csvLines(
      "codigo,produto,valor_centavos",
      sorted.map((r) => [r.codigo, r.produto, String(r.valor)]),
    ),
    "build/03-ranking.csv": csvLines(
      "posicao,codigo,produto,valor_centavos",
      ranked.map((r) => [String(r.pos), r.codigo, r.produto, String(r.valor)]),
    ),
    "build/04-acumulado.csv": csvLines(
      "posicao,codigo,valor_centavos,acumulado_centavos",
      ranked.map((r) => {
        running += r.valor;
        return [String(r.pos), r.codigo, String(r.valor), String(running)];
      }),
    ),
    "build/05-primeiros3.txt": `${ranked
      .slice(0, 3)
      .map((r) => r.codigo)
      .join("\n")}\n`,
    "build/06-faixas.csv": csvLines(
      "posicao,codigo,valor_centavos,faixa",
      ranked.map((r) => [String(r.pos), r.codigo, String(r.valor), r.faixa]),
    ),
    "build/07-contagem.txt": `${["A", "B", "C"]
      .map((f) => `${f}=${ranked.filter((r) => r.faixa === f && r.valor >= 5_000).length}`)
      .join("\n")}\n`,
    "build/08-soma-faixas.txt": `${["A", "B", "C"].map((f) => `${f}=${sumOf(f)}`).join("\n")}\n`,
    "build/09-extremos.txt": `primeiro=${(ranked[0] as { codigo: string }).codigo}\nultimo=${(ranked[n - 1] as { codigo: string }).codigo}\n`,
    "build/11-percentual.txt": `A=${pct}\n`,
    "build/12-resumo.md": `${[
      "# Resumo",
      `Itens: ${n}`,
      `Total: ${total}`,
      `Primeiro: ${(ranked[0] as { codigo: string }).codigo}`,
      `Ultimo: ${(ranked[n - 1] as { codigo: string }).codigo}`,
      `Faixa A: ${sumOf("A")} (${pct})`,
      `Faixa B: ${sumOf("B")}`,
      `Faixa C: ${sumOf("C")}`,
    ].join("\n")}\n`,
  };
  const faixaRows = (f: string) =>
    csvLines(
      "codigo,produto,valor_centavos",
      ranked.filter((r) => r.faixa === f).map((r) => [r.codigo, r.produto, String(r.valor)]),
    );
  if (order === "asc") files["build/10-faixa-a.csv"] = faixaRows("A");
  else files["build/10-faixa-c.csv"] = faixaRows("C");
  return files;
}

/** The checks use these: the percentage must not sit on a rounding tie, or bots could differ. */
export function percentageTies(): boolean {
  const { valid } = buildInput();
  const total = valid.reduce((s, r) => s + r.valor, 0);
  return (["asc", "desc"] as const).some((order) => {
    const dir = order === "asc" ? 1 : -1;
    const sorted = [...valid].sort((a, b) =>
      a.valor !== b.valor ? dir * (a.valor - b.valor) : a.codigo < b.codigo ? -1 : 1,
    );
    const a = sorted.slice(0, sorted.length / 3).reduce((s, r) => s + r.valor, 0);
    return (a * 2000) % (2 * total) === total;
  });
}

const INSTRUCOES = `# Procedimento de 12 etapas

Entrada: \`entrada.csv\` (colunas \`codigo,produto,valor_centavos\`). Cada etapa grava um arquivo em \`build/\`.
Faça **uma etapa de cada vez**, na ordem, cada uma com o seu próprio comando, e confira o arquivo gerado
antes de seguir. Não escreva um único script que faça todas as etapas. Todos os arquivos terminam com uma
quebra de linha e usam \`\\n\`. Os arquivos CSV têm cabeçalho e usam vírgula, sem espaços em volta dos campos.

1. \`build/01-limpo.csv\`: colunas \`codigo,produto,valor_centavos\`. Tire os espaços das pontas de cada campo e
   descarte as linhas cujo valor_centavos não seja um inteiro (só dígitos). Mantenha a ordem da entrada.
2. \`build/02-ordenado.csv\`: as mesmas colunas, ordenadas por valor_centavos **crescente** (o menor primeiro);
   o empate se desfaz por codigo crescente (comparação de texto simples).
3. \`build/03-ranking.csv\`: colunas \`posicao,codigo,produto,valor_centavos\`; posicao vai de 1 em diante, na ordem da etapa 2.
4. \`build/04-acumulado.csv\`: colunas \`posicao,codigo,valor_centavos,acumulado_centavos\`; acumulado é a soma
   corrente de valor_centavos até aquela linha, na ordem da etapa 3.
5. \`build/05-primeiros3.txt\`: os codigos das 3 primeiras linhas da etapa 3, um por linha.
6. \`build/06-faixas.csv\`: colunas \`posicao,codigo,valor_centavos,faixa\`. Divida as linhas da etapa 3 em três terços
   iguais, na ordem: o primeiro terço é a faixa A, o segundo a B, o terceiro a C.
7. \`build/07-contagem.txt\`: três linhas \`A=<n>\`, \`B=<n>\`, \`C=<n>\`, em que n é quantas linhas da faixa têm
   valor_centavos maior ou igual a 5000 (etapa 6).
8. \`build/08-soma-faixas.txt\`: três linhas \`A=<soma>\`, \`B=<soma>\`, \`C=<soma>\` com a soma de valor_centavos de cada faixa.
9. \`build/09-extremos.txt\`: duas linhas, \`primeiro=<codigo da posicao 1>\` e \`ultimo=<codigo da última posicao>\`.
10. \`build/10-faixa-a.csv\`: colunas \`codigo,produto,valor_centavos\`, só as linhas da faixa A, na ordem.
11. \`build/11-percentual.txt\`: uma linha \`A=<p>%\`, em que p é a soma da faixa A dividida pelo total, vezes 100,
    com 1 casa decimal, arredondando o meio para cima (por exemplo \`41.7%\`).
12. \`build/12-resumo.md\`, exatamente neste formato (o total é a soma de todos os valor_centavos):

\`\`\`
# Resumo
Itens: <quantidade de linhas da etapa 1>
Total: <total>
Primeiro: <codigo da posicao 1>
Ultimo: <codigo da última posicao>
Faixa A: <soma A> (<p>%)
Faixa B: <soma B>
Faixa C: <soma C>
\`\`\`
`;

const MESSAGE =
  "ATENÇÃO, mudança de requisito: a ordem da etapa 2 passa a ser DECRESCENTE por valor_centavos (o maior primeiro; o empate continua por codigo crescente). " +
  "Tudo o que depende da ordem deve refletir isso: refaça as etapas que você já fez e que dependem dela e siga o resto do procedimento com a nova ordem. " +
  "A etapa 10 também muda: em vez da faixa A, liste a faixa C, no arquivo build/10-faixa-c.csv (se você já criou build/10-faixa-a.csv, remova-o). Nada mais muda.";

/** Fires after the sixth working call that touches build/: the pipeline is well under way. */
export function afterSixthBuildCall(
  event: { type: string; seq: number },
  log: Parameters<typeof toolCalls>[0],
): boolean {
  if (event.type !== "tool_result") return false;
  const builds = toolCalls(log).filter(
    (c) => !CONTROL_TOOLS.has(c.name) && JSON.stringify(c.args).includes("build"),
  );
  return builds.length >= 6 && builds[5]?.result?.seq === event.seq;
}

const normalize = (text: string) => text.replaceAll("\r\n", "\n").trimEnd();

export const resumeAfterInterrupt: EvalTask = {
  id: "resume-after-interrupt",
  title: "Procedimento de 12 etapas que muda de rumo no meio: refazer o que já estava pronto",
  category: "long",
  objective:
    "Execute o procedimento de 12 etapas descrito em INSTRUCOES.md, a partir de entrada.csv, gerando os arquivos em build/. " +
    "Faça uma etapa de cada vez, na ordem, cada uma com o seu próprio comando, e confira cada arquivo antes de seguir. " +
    "Se o usuário mandar uma mensagem no meio do trabalho, ela vale: ajuste o que for preciso, inclusive o que já tiver feito. " +
    "Só conclua quando todos os arquivos de build/ estiverem de acordo com o que está valendo.",
  criteria: [
    "Os 12 arquivos de build/ existem com o conteúdo exato que o procedimento (com as mudanças que o usuário enviou) manda.",
    "Nada ficou para trás: nenhum arquivo de build/ reflete a regra antiga e não há arquivos a mais.",
  ],
  limits: { maxTurns: 70, maxCostUsd: 0.6, maxDurationMs: 1_200_000 },
  expect: { status: "done" },
  inboxScript: [
    {
      afterEvent: (event, log) => afterSixthBuildCall(event, log),
      item: { kind: "user_message", text: MESSAGE },
    },
  ],
  async setup(ws) {
    await seedBundle(ws, { "entrada.csv": buildInput().csv, "INSTRUCOES.md": INSTRUCOES });
  },
  async reference(ws) {
    for (const [path, text] of Object.entries(pipeline("asc"))) await ws.writeFile(path, text);
    // The message arrives: the steps that depend on the order are redone, step 10 changes.
    await ws.exec("rm -f build/10-faixa-a.csv");
    for (const [path, text] of Object.entries(pipeline("desc"))) await ws.writeFile(path, text);
  },
  async verify(ctx) {
    const checks = [statusCheck(ctx, "done")];
    const messages = eventsOf(ctx.events, "user_message");
    const first = messages[0];
    checks.push(
      check(
        "a mensagem de mudança chegou ao bot no meio do trabalho",
        first !== undefined,
        `${messages.length} mensagem(ns) entregue(s)`,
      ),
    );
    if (first !== undefined) {
      const calls = toolCalls(ctx.events).filter((c) => !CONTROL_TOOLS.has(c.name));
      const before = calls.filter(
        (c) => c.seq < first.seq && JSON.stringify(c.args).includes("build"),
      );
      const after = calls.filter(
        (c) => c.seq > first.seq && JSON.stringify(c.args).includes("build"),
      );
      checks.push(
        check(
          "havia etapas feitas antes da mensagem e houve trabalho depois dela",
          before.length >= 3 && after.length >= 1,
          `${before.length} chamadas em build/ antes, ${after.length} depois`,
        ),
      );
    }
    const expected = pipeline("desc");
    for (const [path, want] of Object.entries(expected)) {
      const got = await readText(ctx.ws, path);
      checks.push(
        check(
          `${path} reflete a nova ordem`,
          got !== null && normalize(got) === normalize(want),
          got === null
            ? "arquivo ausente"
            : `obtido ${JSON.stringify(normalize(got).slice(0, 120))}`,
        ),
      );
    }
    const listing = await ctx.ws.exec("find build -type f | sort", { timeoutMs: 30_000 });
    const found = listing.stdout.split("\n").filter((l) => l !== "");
    const wanted = Object.keys(expected).sort();
    const extra = found.filter((f) => !wanted.includes(f));
    checks.push(
      check(
        "build/ tem exatamente os 12 arquivos esperados (nada antigo sobrou)",
        extra.length === 0 && found.length === wanted.length,
        extra.length > 0 ? `a mais: ${extra.join(", ")}` : `${found.length} arquivos`,
      ),
    );
    return result(checks, { mensagensEntregues: messages.length });
  },
};
