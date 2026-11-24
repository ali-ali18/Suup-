import { check } from "../kit.js";
import type { DocumentTaskSpec } from "./kit.js";
import {
  bodyLines,
  commonPdfChecks,
  dominantSize,
  hasText,
  openPdf,
  squash,
} from "./pdf-checks.js";

const TITLE = "Relatório Trimestral de Vendas";
const SECTIONS = ["Resumo executivo", "Resultados por região", "Próximos passos"];
const TABLE_HEADER = ["Região", "Receita", "Variação"];
const TABLE_ROWS = [
  ["Sul", "R$ 120.000", "+8%"],
  ["Sudeste", "R$ 340.000", "+12%"],
  ["Nordeste", "R$ 95.000", "+5%"],
];
const BULLETS = [
  "Ampliar a operação no Nordeste",
  "Revisar a política de preços",
  "Capacitar a equipe de atendimento",
];

/** A bullet marker is a short run of characters that are not letters or digits. */
const isMarker = (prefix: string): boolean =>
  prefix.length >= 1 &&
  prefix.length <= 2 &&
  [...prefix].every((ch) => ch.toLowerCase() === ch.toUpperCase() && !(ch >= "0" && ch <= "9"));

export const reportPdf: DocumentTaskSpec = {
  name: "doc-report-pdf",
  title: "Relatório em PDF com seções, lista e tabela",
  extension: ".pdf",
  limits: { maxTurns: 30, maxCostUsd: 0.45, maxDurationMs: 600_000 },
  objective: [
    `Faça um relatório em PDF chamado relatorio-vendas.pdf e entregue-o a mim. Título do documento: "${TITLE}".`,
    `Ele tem três seções, com estes títulos: "${SECTIONS[0]}" (um parágrafo curto de duas ou três frases sobre o trimestre), "${SECTIONS[1]}" (uma tabela) e "${SECTIONS[2]}" (uma lista de itens com marcadores).`,
    `A tabela tem o cabeçalho ${TABLE_HEADER.join(" | ")} e três linhas: ${TABLE_ROWS.map((r) => r.join(" | ")).join("; ")}.`,
    `A lista de itens tem exatamente estes três itens: ${BULLETS.map((b) => `"${b}"`).join("; ")}.`,
    "O documento deve caber em no máximo 2 páginas, em papel A4, com os acentos corretos.",
  ].join("\n"),
  criteria: [
    "O PDF relatorio-vendas.pdf foi entregue ao usuário.",
    "Tem o título, as três seções, a tabela e a lista com marcadores pedidos.",
    "Tem no máximo 2 páginas, é A4 e os acentos estão corretos.",
  ],
  async judge(file) {
    const pdf = await openPdf(file.bytes);
    const lines = bodyLines(pdf);
    const size = dominantSize(lines);
    const titleLine = lines.find((l) => squash(l.text).includes(squash(TITLE)));
    // A bullet is a glyph before the text, or (when the maker draws it as a shape, which no text
    // extraction sees) a line set in from the text of the page.
    const textLeft = Math.min(...lines.map((l) => l.left));
    const unlisted = BULLETS.filter((item) => {
      const line = lines.find((l) => l.text.includes(item));
      if (line === undefined) return true;
      const before = line.text.slice(0, line.text.indexOf(item)).trim();
      return !(isMarker(before) || line.left - textLeft >= 8);
    });
    const checks = [
      ...commonPdfChecks(pdf),
      check("no máximo 2 páginas", pdf.pages <= 2, `${pdf.pages} página(s)`),
      check(
        "o título aparece e é maior que o texto",
        titleLine !== undefined && titleLine.size > size * 1.15,
        titleLine === undefined
          ? "título ausente"
          : `título ${titleLine.size.toFixed(1)} pt, texto ${size} pt`,
      ),
      check(
        "as três seções estão no texto",
        SECTIONS.every((s) => hasText(pdf, s)),
        SECTIONS.filter((s) => !hasText(pdf, s)).join(", ") || undefined,
      ),
      check(
        "os acentos saíram corretos (Região, Variação, ções, ã)",
        ["Região", "Variação", "operação", "política", "atendimento"].every((w) => hasText(pdf, w)),
      ),
      check(
        "a tabela tem o cabeçalho e as três linhas, cada uma numa linha do papel",
        [TABLE_HEADER, ...TABLE_ROWS].every((row) =>
          lines.some((l) => squash(l.text).includes(squash(row.join("")))),
        ),
        [TABLE_HEADER, ...TABLE_ROWS]
          .filter((row) => !lines.some((l) => squash(l.text).includes(squash(row.join("")))))
          .map((r) => r.join(" | "))
          .join("; ") || undefined,
      ),
      check(
        "a lista tem os três itens, cada um numa linha própria, com marcador ou recuo",
        unlisted.length === 0,
        unlisted.join("; ") || undefined,
      ),
    ];
    return { checks, observations: { paginas: pdf.pages } };
  },
};
