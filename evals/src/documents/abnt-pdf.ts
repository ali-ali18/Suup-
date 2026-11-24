import { check, runPython } from "../kit.js";
import type { DocumentTaskSpec } from "./kit.js";
import { commonPdfChecks, hasText, measureLayout, openPdf } from "./pdf-checks.js";

const TITLE = "O Impacto do Trabalho Remoto na Produtividade";
const SECTIONS = ["1 INTRODUÇÃO", "2 DESENVOLVIMENTO"];
const CAPTION = "Figura 1 – Produtividade por trimestre";
const SOURCE = "Fonte: elaborado pelo autor (2026).";

// A small bar chart as a PNG, written with the standard library only (the bot's machine may have
// no imaging library, and the file is the same for every run).
const MAKE_PNG = `
import struct, zlib
w, h = 480, 270
rows = []
bars = [(40, 110), (140, 160), (240, 90), (340, 200)]
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        px = (255, 255, 255)
        for left, height in bars:
            if left <= x < left + 80 and y >= h - height - 20 and y < h - 20:
                px = (47, 75, 124)
        if y == h - 20 and 20 <= x < w - 20:
            px = (0, 0, 0)
        row += bytes(px)
    rows.append(bytes(row))
raw = b"".join(rows)
def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open("grafico.png", "wb").write(png)
`;

export const abntPdf: DocumentTaskSpec = {
  name: "doc-abnt-pdf",
  title: "Trabalho acadêmico em PDF nas normas básicas da ABNT",
  extension: ".pdf",
  limits: { maxTurns: 30, maxCostUsd: 0.45, maxDurationMs: 600_000 },
  objective: [
    `Faça um trabalho acadêmico curto em PDF chamado trabalho-abnt.pdf, no formato básico da ABNT, e entregue-o a mim. Título: "${TITLE}".`,
    `Formato: papel A4; margens de 3 cm (superior e esquerda) e 2 cm (inferior e direita); fonte de 12 pt; espaçamento de 1,5 entre linhas; texto justificado.`,
    `Seções, com estes títulos exatos: "${SECTIONS[0]}" e "${SECTIONS[1]}". Cada uma com pelo menos dois parágrafos; o texto todo com pelo menos 300 palavras, sobre o título.`,
    `Na seção 2 inclua a figura grafico.png (já está na sua pasta de trabalho). A legenda da figura é "${CAPTION}" e, logo abaixo da figura, a fonte: "${SOURCE}"`,
  ].join("\n"),
  criteria: [
    "O PDF trabalho-abnt.pdf foi entregue ao usuário.",
    "A4, margens 3/2/2/3 cm, 12 pt, espaçamento 1,5 e texto justificado.",
    "Tem as duas seções, a figura com a legenda e a fonte, e pelo menos 300 palavras.",
  ],
  async setup(ws) {
    const made = await runPython(ws, MAKE_PNG);
    if (made.exitCode !== 0) throw new Error(`não foi possível criar grafico.png: ${made.stderr}`);
  },
  async judge(file) {
    const pdf = await openPdf(file.bytes);
    const m = measureLayout(pdf);
    const near = (value: number, want: number) => Math.abs(value - want) <= 0.3;
    const checks = [
      ...commonPdfChecks(pdf),
      check("fonte de 12 pt no texto", Math.abs(m.fontSize - 12) <= 0.3, `${m.fontSize} pt`),
      check(
        "margem esquerda de 3 cm e direita de 2 cm (medidas no texto)",
        near(m.leftCm, 3) && near(m.rightCm, 2),
        `esquerda ${m.leftCm} cm, direita ${m.rightCm} cm`,
      ),
      check(
        "o texto não invade a margem superior (3 cm) nem a inferior (2 cm)",
        m.topCm >= 3 - 0.3 && m.bottomCm >= 2 - 0.3,
        `topo ${m.topCm} cm, base ${m.bottomCm} cm`,
      ),
      check(
        "espaçamento de 1,5 entre linhas",
        m.lineSpacing >= 1.4 && m.lineSpacing <= 2.1,
        `${m.lineSpacing} vez(es) o corpo da fonte`,
      ),
      check(
        "texto justificado",
        m.justifiedShare >= 0.6,
        `${Math.round(m.justifiedShare * 100)}% das linhas chegam à margem direita`,
      ),
      check("tem pelo menos 300 palavras", m.bodyWords >= 300, `${m.bodyWords} palavras`),
      check(
        "o título e as duas seções estão no texto",
        [TITLE, ...SECTIONS].every((s) => hasText(pdf, s)),
      ),
      check("a figura está no PDF", pdf.images >= 1, `${pdf.images} imagem(ns)`),
      // The dash or colon after "Figura 1" is the maker's choice; what is checked is the content.
      check(
        "legenda (Figura 1 e o título) e a fonte da figura",
        ["Figura 1", "Produtividade por trimestre", "Fonte", "elaborado pelo autor (2026)"].every(
          (part) => hasText(pdf, part),
        ),
      ),
    ];
    return {
      checks,
      observations: {
        paginas: pdf.pages,
        fonteMedida: m.fontSize,
        espacamentoMedido: m.lineSpacing,
        justificadoMedido: m.justifiedShare,
        margensMedidasCm: `${m.topCm}/${m.rightCm}/${m.bottomCm}/${m.leftCm}`,
      },
    };
  },
};
