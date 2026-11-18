import { isDeepStrictEqual } from "node:util";
import { check, readText, result, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const CSV = `id,nome,cidade,saldo,observacao
1,"Silva, João",São Paulo,1250.50,"cliente ""VIP"""
2,Maria Conceição,,0,
3,José d'Ávila,"Belo Horizonte, MG",-45.9,pagou em 2x
4,Ítalo Çoelho,Curitiba,300,"retirar na loja, andar 2"
`;

const EXPECTED = [
  { id: 1, nome: "Silva, João", cidade: "São Paulo", saldo: 1250.5, observacao: 'cliente "VIP"' },
  { id: 2, nome: "Maria Conceição", cidade: null, saldo: 0, observacao: null },
  {
    id: 3,
    nome: "José d'Ávila",
    cidade: "Belo Horizonte, MG",
    saldo: -45.9,
    observacao: "pagou em 2x",
  },
  {
    id: 4,
    nome: "Ítalo Çoelho",
    cidade: "Curitiba",
    saldo: 300,
    observacao: "retirar na loja, andar 2",
  },
];

/** Transform a CSV with the usual traps (quoted commas, escaped quotes, empty fields, accents). */
export const csvToJson: EvalTask = {
  id: "csv-to-json",
  title: "Converter um CSV difícil (vírgulas entre aspas, campos vazios, acentos) em JSON",
  category: "files",
  objective:
    "Converta clientes.csv em clientes.json: uma lista JSON com um objeto por linha de dados, na mesma ordem. " +
    'Esquema de cada objeto: "id" (número inteiro), "nome" (texto), "cidade" (texto, ou null se o campo estiver vazio), ' +
    '"saldo" (número) e "observacao" (texto, ou null se o campo estiver vazio). Preserve os acentos e o texto exato dos campos.',
  criteria: [
    "clientes.json é um JSON válido com uma lista de 4 objetos, na ordem do CSV.",
    "Campos vazios viram null e os números são números, não texto.",
  ],
  limits: { maxTurns: 14, maxCostUsd: 0.4, maxDurationMs: 240_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile("clientes.csv", CSV);
  },
  async reference(ws) {
    await ws.writeFile("clientes.json", `${JSON.stringify(EXPECTED, null, 2)}\n`);
  },
  async verify(ctx) {
    const text = await readText(ctx.ws, "clientes.json");
    let parsed: unknown;
    let parseError: string | undefined;
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        parseError = (error as Error).message;
      }
    }
    const equal = parseError === undefined && text !== null && isDeepStrictEqual(parsed, EXPECTED);
    let detail: string | undefined;
    if (text === null) detail = "clientes.json ausente";
    else if (parseError !== undefined) detail = `JSON inválido: ${parseError}`;
    else if (!equal && Array.isArray(parsed)) {
      const bad = EXPECTED.findIndex((row, i) => !isDeepStrictEqual(parsed[i], row));
      detail =
        parsed.length !== EXPECTED.length
          ? `${parsed.length} objeto(s) em vez de ${EXPECTED.length}`
          : `o objeto ${bad + 1} difere: esperado ${JSON.stringify(EXPECTED[bad])}, obtido ${JSON.stringify(parsed[bad])}`;
    } else if (!equal) detail = "o JSON não é uma lista";
    return result([
      statusCheck(ctx, "done"),
      check("clientes.json é exatamente igual ao esperado", equal, detail),
    ]);
  },
};
