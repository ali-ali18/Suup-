import { check, eventsOf, readText, result, statusCheck, toolCalls } from "../kit.js";
import type { EvalTask } from "../types.js";
import { diffHashes, expectedHashes, hashesOf, Rng, seedBundle } from "./kit.js";

const DEPOTS = ["SP", "RJ", "BH", "CWB", "POA"] as const;
const DAYS = 20;
const CARRIERS = ["RapidoSul", "TransLeste", "ViaNorte", "EntregaJa", "Cargueiro"];
const NOTES = [
  "entregue na portaria",
  "recebido pelo responsável do setor",
  "cliente ausente, deixado com a vizinhança",
  "assinatura conferida no comprovante digital",
  "volume com avaria leve na embalagem externa",
  "entrega fora da janela combinada por trânsito",
  "reagendada a pedido do cliente para a semana seguinte",
  "endereço confirmado por telefone antes da saída",
  "conferência de lacre feita pelo motorista",
  "sem observações do recebedor no ato da entrega",
];
const OC_TEXTS = [
  "temperatura da câmara acima do limite por alguns minutos",
  "veículo atrasou na doca por conta da fila de descarga",
  "lacre rompido encontrado na conferência final",
  "falha momentânea na leitura do código de barras",
  "não houve dano grave, apenas arranhão na caixa",
  "divergência de peso informada pelo motorista",
  "cliente pediu segunda via do comprovante",
  "etiqueta ilegível, reimpressa no balcão",
  "pallet reposicionado por risco de tombamento",
  "coleta de devolução registrada sem pendências",
];

export interface AuditData {
  files: Record<string, string>;
  /** The twelve figures a correct report holds. */
  expected: Record<string, unknown>;
  totalBytes: number;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

interface Line {
  id: string;
  client: string;
  weight: number;
  value: number;
  status: string;
  carrier: string;
  note: string;
}

const formatLine = (l: Line) =>
  `${l.id};${l.client};${l.weight};${l.value};${l.status};${l.carrier};${l.note}`;

/** The seeded files and the twelve figures computed from them by parsing, like a solver would. */
export function buildAudit(): AuditData {
  const rng = new Rng(20_240_305);
  const files: Record<string, string> = {};
  const delivery = new Map<string, { header: string[]; lines: Line[]; extra: Line[] }>();
  let counter = 1000;

  for (const depot of DEPOTS) {
    const cancelRate = depot === "BH" ? 0.16 : 0.07;
    for (let day = 1; day <= DAYS; day++) {
      const name = `${depot}-2024-03-${pad(day, 2)}.txt`;
      const count = rng.between(26, 32);
      const lines: Line[] = [];
      for (let i = 0; i < count; i++) {
        counter += rng.between(1, 3);
        const roll = rng.float();
        lines.push({
          id: `ENT-${pad(counter, 5)}`,
          client: `CLI-${pad(rng.between(1, 400), 4)}`,
          weight: rng.between(800, 45_000),
          value: rng.between(2_500, 480_000),
          status:
            roll < cancelRate ? "CANCELADA" : roll < cancelRate + 0.08 ? "DEVOLVIDA" : "ENTREGUE",
          carrier: rng.pick(CARRIERS),
          note: rng.pick(NOTES),
        });
      }
      delivery.set(name, {
        header: [
          `# deposito=${depot} data=2024-03-${pad(day, 2)}`,
          "# colunas: id;cliente;peso_g;valor_centavos;status;transportadora;obs",
        ],
        lines,
        extra: [],
      });
    }
  }

  // The biggest delivered value, and a bigger one that was cancelled (a decoy).
  const rj14 = delivery.get("RJ-2024-03-14.txt");
  const bh02 = delivery.get("BH-2024-03-02.txt");
  if (rj14 === undefined || bh02 === undefined) throw new Error("seed");
  const winner = rj14.lines[6] as Line;
  winner.value = 9_876_543;
  winner.status = "ENTREGUE";
  const decoy = bh02.lines[3] as Line;
  decoy.value = 12_345_678;
  decoy.status = "CANCELADA";

  // Reprocessed lines: the first two lines of a day are repeated, exactly, at the end of the next.
  const reprocessed: [string, string][] = [];
  for (const [depot, from] of [
    ["SP", 3],
    ["SP", 11],
    ["RJ", 6],
    ["RJ", 17],
    ["BH", 8],
    ["BH", 14],
    ["CWB", 2],
    ["CWB", 12],
    ["CWB", 18],
    ["POA", 5],
    ["POA", 9],
    ["POA", 15],
  ] as const) {
    reprocessed.push([
      `${depot}-2024-03-${pad(from, 2)}.txt`,
      `${depot}-2024-03-${pad(from + 1, 2)}.txt`,
    ]);
  }
  for (const [source, target] of reprocessed) {
    const src = delivery.get(source);
    const dst = delivery.get(target);
    if (src === undefined || dst === undefined) throw new Error("seed");
    dst.extra.push(...src.lines.slice(0, 2));
  }

  const render = (name: string) => {
    const d = delivery.get(name);
    if (d === undefined) throw new Error("seed");
    return `${[...d.header, ...d.lines.map(formatLine), "", ...d.extra.map(formatLine)].join("\n")}\n`;
  };

  // The ledger is cut from the files as they are; three files are then changed behind its back.
  const ledgerRows: string[] = ["arquivo,linhas,valor_total_centavos"];
  const names = [...delivery.keys()];
  for (const name of names) {
    const d = delivery.get(name);
    if (d === undefined) throw new Error("seed");
    const all = [...d.lines, ...d.extra];
    ledgerRows.push(`${name},${all.length},${all.reduce((s, l) => s + l.value, 0)}`);
  }
  for (const [name, delta] of [
    ["SP-2024-03-09.txt", 15_000],
    ["BH-2024-03-17.txt", -4_250],
    ["POA-2024-03-02.txt", 730],
  ] as const) {
    const d = delivery.get(name);
    if (d === undefined || d.extra.length > 0)
      throw new Error("seed: divergent file must be clean");
    const last = d.lines.at(-1) as Line;
    last.value += delta;
  }
  for (const name of names) files[`entregas/${name}`] = render(name);
  files["ledger.csv"] = `${ledgerRows.join("\n")}\n`;

  // Incident logs.
  for (let n = 1; n <= 45; n++) {
    const lines: string[] = [];
    const count = rng.between(14, 18);
    for (let i = 0; i < count; i++) {
      const roll = rng.float();
      const level = roll < 0.15 ? "GRAVE" : roll < 0.45 ? "AVISO" : "INFO";
      const stamp = `2024-03-${pad(rng.between(1, 20), 2)}T${pad(rng.between(5, 22), 2)}:${pad(rng.between(0, 59), 2)}:${pad(rng.between(0, 59), 2)}`;
      lines.push(
        `${stamp} | nivel=${level} | ENT-${pad(rng.between(1001, counter), 5)} | ${rng.pick(OC_TEXTS)}`,
      );
    }
    files[`ocorrencias/oc-${pad(n, 3)}.log`] = `${lines.join("\n")}\n`;
  }

  // Noise: a client list and a carrier list nobody needs.
  const clients = ["codigo,nome,cidade"];
  for (let c = 1; c <= 400; c++) {
    clients.push(
      `CLI-${pad(c, 4)},Cliente ${pad(c, 4)} Comércio Ltda,${rng.pick(["Campinas", "Niterói", "Contagem", "Londrina", "Canoas"])}`,
    );
  }
  files["clientes.csv"] = `${clients.join("\n")}\n`;
  files["transportadoras.csv"] =
    `nome,sigla\n${CARRIERS.map((c) => `${c},${c.slice(0, 3).toUpperCase()}`).join("\n")}\n`;
  files["LEIAME.md"] =
    "# Registros de março\n\nPasta `entregas/`: um arquivo por depósito e dia, com linhas `id;cliente;peso_g;valor_centavos;status;transportadora;obs`.\nPasta `ocorrencias/`: registros de ocorrências. `ledger.csv`: o fechamento contábil de cada arquivo de entregas.\nLinhas em branco e linhas que começam com `#` não são dados.\n";

  return { files, expected: figures(files), totalBytes: totalBytes(files) };
}

const totalBytes = (files: Record<string, string>) =>
  Object.values(files).reduce((s, t) => s + Buffer.byteLength(t, "utf8"), 0);

const dataLines = (text: string) =>
  text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));

/** Computes the twelve figures by parsing the files (independent of how they were generated). */
function figures(files: Record<string, string>): Record<string, unknown> {
  const names = Object.keys(files)
    .filter((p) => p.startsWith("entregas/"))
    .map((p) => p.slice("entregas/".length))
    .sort();
  const firstSeen = new Map<string, { line: string[]; file: string }>();
  let all = 0;
  for (const name of names) {
    for (const raw of dataLines(files[`entregas/${name}`] as string)) {
      all += 1;
      const f = raw.split(";");
      if (!firstSeen.has(f[0] as string)) firstSeen.set(f[0] as string, { line: f, file: name });
    }
  }
  const unique = [...firstSeen.values()];
  const delivered = unique.filter((u) => u.line[4] === "ENTREGUE");
  const best = delivered.reduce((a, b) => (Number(b.line[3]) > Number(a.line[3]) ? b : a));
  const cancels = new Map<string, number>();
  for (const u of unique) {
    if (u.line[4] !== "CANCELADA") continue;
    const depot = u.file.split("-")[0] as string;
    cancels.set(depot, (cancels.get(depot) ?? 0) + 1);
  }
  const topDepot = [...cancels.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];

  let severe = 0;
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("ocorrencias/")) continue;
    severe += dataLines(text).filter((l) => l.split(" | ")[1] === "nivel=GRAVE").length;
  }

  const ledger = new Map<string, number>();
  for (const row of dataLines(files["ledger.csv"] as string).slice(1)) {
    const [name, , value] = row.split(",");
    ledger.set(name as string, Number(value));
  }
  const divergent: string[] = [];
  let divergence = 0;
  for (const name of names) {
    const real = dataLines(files[`entregas/${name}`] as string).reduce(
      (s, l) => s + Number(l.split(";")[3]),
      0,
    );
    const booked = ledger.get(name) as number;
    if (real !== booked) {
      divergent.push(name);
      divergence += booked - real;
    }
  }

  return {
    linhas_unicas: unique.length,
    linhas_duplicadas: all - unique.length,
    valor_entregue_centavos: delivered.reduce((s, u) => s + Number(u.line[3]), 0),
    peso_entregue_g: delivered.reduce((s, u) => s + Number(u.line[2]), 0),
    maior_entrega_id: best.line[0],
    maior_entrega_arquivo: best.file,
    deposito_mais_cancelamentos: topDepot[0],
    cancelamentos_nesse_deposito: topDepot[1],
    clientes_distintos: new Set(unique.map((u) => u.line[1])).size,
    ocorrencias_graves: severe,
    arquivos_divergentes: divergent.sort(),
    divergencia_total_centavos: divergence,
  };
}

let cached: AuditData | undefined;
const audit = (): AuditData => {
  cached ??= buildAudit();
  return cached;
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SOURCES = ["entregas", "ocorrencias", "ledger.csv", "clientes.csv", "transportadoras.csv"];

export const bigContextAudit: EvalTask = {
  id: "big-context-audit",
  title:
    "Auditar ~150 arquivos de registro (≈350 KB) e apurar 12 números, cruzando com um fechamento",
  category: "research",
  objective:
    "Esta pasta tem os registros de março de uma operação de entregas: entregas/ (um arquivo por depósito e dia), ocorrencias/ (registros de ocorrências), ledger.csv (o fechamento de cada arquivo de entregas) e alguns arquivos de apoio. " +
    "Apure os 12 números abaixo e grave-os em relatorio.json, na raiz da sua pasta de trabalho, como um objeto JSON com exatamente estas chaves. " +
    "Linhas de entrega são as linhas de dados (não vazias e que não começam com `#`) no formato `id;cliente;peso_g;valor_centavos;status;transportadora;obs`. " +
    "Algumas linhas aparecem repetidas, exatamente iguais, em mais de um arquivo (reprocessamento): uma entrega é identificada pelo seu id, e as figuras 3 a 9 contam cada id uma só vez. " +
    "(1) linhas_unicas: quantos ids distintos de entrega existem. " +
    "(2) linhas_duplicadas: quantas linhas de entrega existem a mais do que ids distintos. " +
    "(3) valor_entregue_centavos: soma de valor_centavos das entregas distintas com status ENTREGUE. " +
    "(4) peso_entregue_g: soma de peso_g dessas mesmas entregas. " +
    "(5) maior_entrega_id: o id da entrega distinta ENTREGUE de maior valor_centavos. " +
    "(6) maior_entrega_arquivo: o nome do arquivo (só o nome, sem a pasta) em que ela aparece. " +
    "(7) deposito_mais_cancelamentos: o código do depósito (o prefixo do nome do arquivo, como SP) com mais entregas distintas com status CANCELADA. " +
    "(8) cancelamentos_nesse_deposito: quantas são. " +
    "(9) clientes_distintos: quantos clientes diferentes aparecem entre as entregas distintas, de qualquer status. " +
    "(10) ocorrencias_graves: quantas linhas de ocorrencias/ têm o campo nivel igual a GRAVE (o campo, e não a palavra solta no texto). " +
    "(11) arquivos_divergentes: a lista, em ordem alfabética, dos nomes dos arquivos de entregas cuja soma de valor_centavos (todas as linhas do arquivo, de qualquer status, repetidas incluídas) é diferente do valor_total_centavos que o ledger.csv registra para ele. " +
    "(12) divergencia_total_centavos: a soma, nesses arquivos, de (valor do ledger menos a soma real do arquivo); pode ser negativa. " +
    "Não altere os arquivos de dados. Há muito texto aqui: use busca e scripts em vez de tentar ler tudo.",
  criteria: [
    "relatorio.json existe na raiz, com as 12 chaves pedidas e os valores exatos.",
    "Os arquivos de dados não foram alterados.",
  ],
  limits: { maxTurns: 70, maxCostUsd: 0.9, maxDurationMs: 1_200_000 },
  expect: { status: "done" },
  async setup(ws) {
    await seedBundle(ws, audit().files);
  },
  async reference(ws) {
    await ws.writeFile("relatorio.json", `${JSON.stringify(audit().expected, null, 2)}\n`);
  },
  async verify(ctx) {
    const { expected, files } = audit();
    const checks = [statusCheck(ctx, "done")];
    const text = await readText(ctx.ws, "relatorio.json");
    let report: Record<string, unknown> | null = null;
    let parseError = text === null ? "relatorio.json ausente" : "";
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          report = parsed as Record<string, unknown>;
        } else parseError = "o JSON não é um objeto";
      } catch {
        parseError = "relatorio.json não é um JSON válido";
      }
    }
    checks.push(check("relatorio.json é um objeto JSON", report !== null, parseError));
    Object.keys(expected).forEach((key, i) => {
      const got = report?.[key];
      checks.push(
        check(
          `figura ${i + 1} (${key})`,
          report !== null && sameValue(got, expected[key]),
          report === null
            ? parseError
            : `obtido ${JSON.stringify(got) ?? "ausente"}, esperado ${JSON.stringify(expected[key])}`,
        ),
      );
    });
    const hashes = await hashesOf(ctx.ws, SOURCES);
    const drift = diffHashes(hashes, expectedHashes(files, SOURCES));
    checks.push(check("os arquivos de dados não foram alterados", drift === "", drift));

    const calls = toolCalls(ctx.events);
    return result(checks, {
      chamadasDeFerramenta: calls.length,
      leiturasDeArquivo: calls.filter((c) => c.name === "read_file").length,
      comandosDeShell: calls.filter((c) => c.name === "shell").length,
      compactacoes: eventsOf(ctx.events, "compacted").length,
    });
  },
};
