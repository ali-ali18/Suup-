import { inspectXlsx, type XlsxCell } from "@suup/runtime";
import { check } from "../kit.js";
import type { DocumentTaskSpec } from "./kit.js";

const HEADER = ["Produto", "Quantidade", "Preço unitário", "Total"];
const PRODUCTS: [string, number, number][] = [
  ["Cadeira ergonômica", 12, 899.9],
  ["Mesa de escritório", 8, 1250],
  ["Lâmpada LED", 150, 18.5],
  ["Teclado sem fio", 40, 129.9],
  ["Café em grãos", 60, 42],
];

/** A formula without the dollar signs and spaces, in capitals: how two spellings compare equal. */
const plain = (formula: string | null): string =>
  (formula ?? "").replaceAll("$", "").replaceAll(" ", "").replaceAll("=", "").toUpperCase();

export const salesXlsx: DocumentTaskSpec = {
  name: "doc-sales-xlsx",
  title: "Planilha de produtos com fórmulas e moeda em reais",
  extension: ".xlsx",
  limits: { maxTurns: 30, maxCostUsd: 0.45, maxDurationMs: 600_000 },
  objective: [
    "Faça uma planilha Excel chamada produtos.xlsx e entregue-a a mim.",
    `Na primeira aba, linha 1 é o cabeçalho (colunas A a D): ${HEADER.join(" | ")}.`,
    `Linhas 2 a 6, um produto por linha (Produto, Quantidade, Preço unitário): ${PRODUCTS.map(([n, q, p]) => `${n}, ${q}, ${p}`).join("; ")}.`,
    "A coluna D (Total) de cada produto é uma fórmula do Excel: quantidade vezes preço unitário (por exemplo =B2*C2), não o valor digitado.",
    'Na linha 7, "Total" na coluna A e, na coluna D, uma fórmula do Excel que soma os totais dos cinco produtos.',
    "Os preços (coluna C) e os totais (coluna D, linhas 2 a 7) devem aparecer em reais, com o formato de moeda brasileira (R$).",
  ].join("\n"),
  criteria: [
    "A planilha produtos.xlsx foi entregue ao usuário.",
    "Tem o cabeçalho, os cinco produtos, as fórmulas de total e o formato de moeda em reais.",
  ],
  async judge(file) {
    const book = inspectXlsx(file.bytes);
    const sheet = book.sheets[0];
    const at = (ref: string): XlsxCell | undefined => sheet?.cells.find((c) => c.ref === ref);
    const rows = [2, 3, 4, 5, 6];
    const formulaCells = (sheet?.cells ?? []).filter((c) => c.formula !== null);
    const badHeader = HEADER.filter((h, i) => at(`${"ABCD"[i]}1`)?.value !== h);
    const badProducts = PRODUCTS.flatMap(([name, qty, price], i) => {
      const r = rows[i] as number;
      const wrong: string[] = [];
      if (at(`A${r}`)?.value !== name) wrong.push(`A${r}`);
      if (at(`B${r}`)?.value !== qty) wrong.push(`B${r}`);
      if (at(`C${r}`)?.value !== price) wrong.push(`C${r}`);
      return wrong;
    });
    const badRowFormulas = rows.filter((r) => {
      const f = plain(at(`D${r}`)?.formula ?? null);
      return f !== `B${r}*C${r}` && f !== `C${r}*B${r}`;
    });
    const total = plain(at("D7")?.formula ?? null);
    const money = ["C2", "C3", "C4", "C5", "C6", "D2", "D3", "D4", "D5", "D6", "D7"];
    const badMoney = money.filter((ref) => !(at(ref)?.format ?? "").includes("R$"));
    const checks = [
      check("a planilha abre e tem uma aba", sheet !== undefined, `${book.sheets.length} aba(s)`),
      check(
        "cabeçalho na linha 1 (A a D)",
        badHeader.length === 0,
        badHeader.join(", ") || undefined,
      ),
      check(
        "cinco produtos nas linhas 2 a 6, com nome, quantidade e preço exatos (acentos intactos)",
        badProducts.length === 0,
        badProducts.join(", ") || undefined,
      ),
      check(
        "o total de cada produto é fórmula (quantidade x preço)",
        badRowFormulas.length === 0,
        badRowFormulas.map((r) => `D${r}`).join(", ") || undefined,
      ),
      check(
        'linha 7: "Total" e a fórmula que soma D2 a D6',
        at("A7")?.value === "Total" &&
          (total === "SUM(D2:D6)" || total === "D2+D3+D4+D5+D6" || total === "SOMA(D2:D6)"),
        `A7=${JSON.stringify(at("A7")?.value ?? null)}, D7=${total || "sem fórmula"}`,
      ),
      check(
        "preços e totais em reais (formato com R$)",
        badMoney.length === 0,
        badMoney.map((ref) => `${ref}: ${at(ref)?.format ?? "?"}`).join(", ") || undefined,
      ),
    ];
    return {
      checks,
      observations: {
        abas: book.sheets.length,
        formulas: formulaCells.length,
        formulasComValorEmCache: formulaCells.filter((c) => c.value !== null).length,
      },
    };
  },
};
