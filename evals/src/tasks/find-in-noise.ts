import { check, mentions, readText, result, statusCheck, toolCalls } from "../kit.js";
import type { EvalTask } from "../types.js";

const ANSWER = "RM-88213-BR";
const RENEWALS = "arquivos/contratos/renovacoes-2024.txt";
const SHIPMENTS = "arquivos/logistica/remessas.csv";

const RENEWALS_TEXT = `# Renovações e cancelamentos de contrato em 2024 (data | tipo | cliente | nome)
2024-01-22 | renovação | C-0388 | Panificadora Alvorada
2024-02-27 | renovação | C-0125 | Clínica Vida
2024-03-14 | renovação | C-0471 | Ferragens Souza Júnior
2024-03-15 | renovação | C-0417 | Ferragens Souza
2024-03-15 | cancelamento | C-0233 | Padaria Estrela
2024-03-16 | renovação | C-0140 | Oficina Dois Irmãos
2024-04-02 | renovação | C-0556 | Mercadinho Bom Preço
`;

const SHIPMENTS_TEXT = `remessa,cliente,codigo_rastreio,status
R-1001,C-0388,RM-77002-BR,entregue
R-1017,C-0417,RM-77102-BR,cancelada
R-1031,C-0125,RM-77945-BR,entregue
R-1042,C-0471,RM-88231-BR,enviada
R-1043,C-0417,${ANSWER},enviada
R-1050,C-0140,RM-88302-BR,enviada
R-1058,C-0233,RM-88377-BR,devolvida
`;

/** Lines that look like the answer but are not it: same date, same client, same codes. */
const DECOYS: Record<string, string> = {
  "arquivos/financeiro/lancamentos-2024-03.txt": `2024-03-12 | pagamento | C-0388 | Panificadora Alvorada, fatura 7/12 paga
2024-03-15 | pagamento | C-0417 | Ferragens Souza, fatura 3/10 paga
2024-03-15 | estorno | C-0233 | Padaria Estrela, estorno de taxa
2024-03-18 | pagamento | C-0140 | Oficina Dois Irmãos, fatura 1/6 paga
`,
  "arquivos/suporte/chamados-2024-03.txt": `2024-03-15 | chamado | C-0233 | cliente pediu segunda via do contrato
2024-03-18 | chamado | C-0471 | dúvida sobre a remessa RM-88231-BR
2024-03-20 | chamado | C-0417 | cliente perguntou da remessa RM-77102-BR, cancelada em janeiro a pedido dele
2024-03-21 | chamado | C-0125 | troca de contato do responsável
`,
};

const SKIP_CLIENTS = new Set([417, 471, 140, 388, 125, 233, 556]);
const KINDS = ["pagamento", "chamado", "reunião", "ajuste", "consulta", "lembrete", "visita"];
const WORDS = [
  "revisão de rotina",
  "ajuste de cadastro",
  "pedido de orçamento",
  "confirmação de endereço",
  "atualização de telefone",
  "nota fiscal reenviada",
  "agenda de visita",
  "relatório mensal enviado",
  "dúvida sobre prazo",
  "boleto reemitido",
];

/** Deterministic pseudo-random numbers, so every run gets the same files. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function noiseFile(seed: number): string {
  const next = lcg(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    let client = 100 + Math.floor(next() * 900);
    while (SKIP_CLIENTS.has(client)) client += 1;
    const month = String(1 + Math.floor(next() * 12)).padStart(2, "0");
    const day = String(1 + Math.floor(next() * 28)).padStart(2, "0");
    lines.push(`2023-${month}-${day} | ${pick(KINDS)} | C-0${client} | ${pick(WORDS)}`);
  }
  return `${lines.join("\n")}\n`;
}

const DIRECTORIES: [name: string, count: number][] = [
  ["financeiro", 7],
  ["suporte", 7],
  ["rh", 6],
  ["reunioes", 6],
  ["contratos", 5],
  ["logistica", 5],
];

/** The 40 files of the tree: 2 with the answer, 2 with decoys, 36 of plain noise. */
function tree(): Record<string, string> {
  const files: Record<string, string> = {
    [RENEWALS]: RENEWALS_TEXT,
    [SHIPMENTS]: SHIPMENTS_TEXT,
    ...DECOYS,
  };
  let seed = 7;
  for (const [directory, count] of DIRECTORIES) {
    for (let i = 1; i <= count; i++) {
      seed += 1;
      files[`arquivos/${directory}/registro-2023-${String(i).padStart(2, "0")}.txt`] =
        noiseFile(seed);
    }
  }
  return files;
}

/** A search task: the answer needs two files, found among 40, with decoys that look right. */
export const findInNoise: EvalTask = {
  id: "find-in-noise",
  title: "Achar uma resposta que exige cruzar dois arquivos entre 40, com iscas parecidas",
  category: "research",
  objective:
    'Na pasta arquivos/ há registros de clientes. Descubra qual cliente teve a renovação de contrato (tipo "renovação") na data 2024-03-15 e qual é o código de rastreio da remessa dele que NÃO foi cancelada. ' +
    "Escreva em resposta.txt, na raiz da sua pasta de trabalho (ao lado da pasta arquivos/, não dentro dela), apenas esse código de rastreio, sem mais nada.",
  criteria: [
    "resposta.txt (na raiz da pasta de trabalho) contém somente o código de rastreio da remessa não cancelada do cliente que renovou o contrato em 2024-03-15.",
  ],
  limits: { maxTurns: 14, maxCostUsd: 0.5, maxDurationMs: 240_000 },
  expect: { status: "done" },
  async setup(ws) {
    for (const [path, content] of Object.entries(tree())) await ws.writeFile(path, content);
  },
  async reference(ws) {
    await ws.writeFile("resposta.txt", `${ANSWER}\n`);
  },
  async verify(ctx) {
    const text = await readText(ctx.ws, "resposta.txt");
    const calls = toolCalls(ctx.events);
    const touched = (file: string) =>
      calls.some(
        (c) =>
          (c.name === "read_file" && c.args.path === file) ||
          (c.name === "shell" &&
            typeof c.args.command === "string" &&
            mentions(c.args.command, file)),
      );
    return result(
      [
        statusCheck(ctx, "done"),
        check(
          `resposta.txt contém exatamente ${ANSWER}`,
          text !== null && text.trim() === ANSWER,
          text === null ? "arquivo ausente" : JSON.stringify(text.trim().slice(0, 120)),
        ),
      ],
      {
        leuArquivoDeRenovacoes: touched(RENEWALS),
        leuArquivoDeRemessas: touched(SHIPMENTS),
        usouSearchFiles: calls.some((c) => c.name === "search_files"),
      },
    );
  },
};
