import { deflateSync } from "node:zlib";
import { createDocumentMaker } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { abntPdf, documentTasks, reportPdf, salesXlsx } from "../src/index.js";

const maker = createDocumentMaker({ author: "Bot de teste" });
const none = new Map<string, Uint8Array>();

async function make(request: Parameters<typeof maker.make>[0], images = none) {
  const result = await maker.make(request, images);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.document.bytes;
}

const failed = (checks: { name: string; pass: boolean }[]) =>
  checks.filter((c) => !c.pass).map((c) => c.name);

describe("the document tasks come in pairs: with the tool and with the bot's own script", () => {
  it("has three tasks in two modes, the same objective in both", () => {
    expect(documentTasks.map((t) => t.id)).toEqual([
      "doc-report-pdf-tool",
      "doc-report-pdf-script",
      "doc-abnt-pdf-tool",
      "doc-abnt-pdf-script",
      "doc-sales-xlsx-tool",
      "doc-sales-xlsx-script",
    ]);
    for (let i = 0; i < documentTasks.length; i += 2) {
      const [withTool, script] = [documentTasks[i], documentTasks[i + 1]];
      expect(withTool?.objective).toBe(script?.objective);
      expect(withTool?.criteria).toEqual(script?.criteria);
      expect(withTool?.deliverFiles).toBe(true);
      expect(withTool?.withoutTools).toBeUndefined();
      expect(script?.deliverFiles).toBe(true);
      expect(script?.withoutTools).toEqual(["create_document"]);
    }
  });

  it("never names the dedicated tool in what the bot is asked", () => {
    for (const task of documentTasks) {
      expect(task.objective).not.toContain("create_document");
      expect(task.objective.toLowerCase()).not.toContain("python");
    }
  });
});

describe("the judges accept a good file and refuse a bad one", () => {
  it("report PDF: the file made with the tool passes; a longer one with no list fails", async () => {
    const good = await make({
      format: "pdf",
      name: "relatorio-vendas.pdf",
      style: "padrao",
      markdown: `# Relatório Trimestral de Vendas

## Resumo executivo

O trimestre foi de crescimento em todas as regiões, com destaque para o Sudeste. A operação ganhou escala sem perder margem.

## Resultados por região

| Região | Receita | Variação |
| --- | --- | --- |
| Sul | R$ 120.000 | +8% |
| Sudeste | R$ 340.000 | +12% |
| Nordeste | R$ 95.000 | +5% |

## Próximos passos

- Ampliar a operação no Nordeste
- Revisar a política de preços
- Capacitar a equipe de atendimento
`,
    });
    const verdict = await reportPdf.judge({
      name: "relatorio-vendas.pdf",
      mime: "application/pdf",
      bytes: good,
    });
    expect(failed(verdict.checks)).toEqual([]);

    const bad = await make({
      format: "pdf",
      name: "r.pdf",
      style: "padrao",
      markdown: `# Relatório Trimestral de Vendas\n\n## Resumo executivo\n\n${"Texto longo sobre o trimestre. ".repeat(400)}`,
    });
    const refused = await reportPdf.judge({ name: "r.pdf", mime: "application/pdf", bytes: bad });
    const names = failed(refused.checks);
    expect(names).toContain("no máximo 2 páginas");
    expect(names).toContain(
      "a lista tem os três itens, cada um numa linha própria, com marcador ou recuo",
    );
  });

  it("ABNT PDF: the academic style passes; the default style is refused on every measure", async () => {
    // A bar-like PNG, big enough to be a figure.
    const png = tinyPng();
    const body = (n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          `Parágrafo ${i + 1}: o trabalho remoto muda a forma como as equipes se organizam, planejam entregas e medem resultados ao longo do trimestre, e por isso exige acordos claros sobre horários, comunicação e metas, com acompanhamento próximo dos gestores e das pessoas envolvidas.`,
      ).join("\n\n");
    const markdown = `# O Impacto do Trabalho Remoto na Produtividade

# 1 INTRODUÇÃO

${body(3)}

# 2 DESENVOLVIMENTO

${body(3)}

![Produtividade por trimestre](grafico.png "elaborado pelo autor (2026)")

${body(2)}
`;
    const images = new Map([["grafico.png", png]]);
    const good = await make({ format: "pdf", name: "t.pdf", style: "academico", markdown }, images);
    const verdict = await abntPdf.judge({ name: "t.pdf", mime: "application/pdf", bytes: good });
    expect(failed(verdict.checks)).toEqual([]);

    const plain = await make({ format: "pdf", name: "t.pdf", style: "padrao", markdown }, images);
    const refused = await abntPdf.judge({ name: "t.pdf", mime: "application/pdf", bytes: plain });
    const names = failed(refused.checks);
    expect(names).toContain("fonte de 12 pt no texto");
    expect(names).toContain("texto justificado");
    expect(names).toContain("margem esquerda de 3 cm e direita de 2 cm (medidas no texto)");
  });

  it("sales xlsx: the sheet made with the tool passes; typed totals and a plain number format fail", async () => {
    const rows = (formulas: boolean, money: boolean) => {
      const product = [
        ["Cadeira ergonômica", 12, 899.9],
        ["Mesa de escritório", 8, 1250],
        ["Lâmpada LED", 150, 18.5],
        ["Teclado sem fio", 40, 129.9],
        ["Café em grãos", 60, 42],
      ] as const;
      const fmt = money ? { format: "currency" as const } : {};
      return [
        ["Produto", "Quantidade", "Preço unitário", "Total"],
        ...product.map(([n, q, p], i) => [
          n,
          q,
          { value: p, ...fmt },
          formulas
            ? { formula: `=B${i + 2}*C${i + 2}`, ...fmt }
            : { value: Math.round(q * p * 100) / 100, ...fmt },
        ]),
        ["Total", null, null, formulas ? { formula: "=SUM(D2:D6)", ...fmt } : { value: 1, ...fmt }],
      ];
    };
    const good = await make({
      format: "xlsx",
      name: "produtos.xlsx",
      sheets: [{ name: "Produtos", rows: rows(true, true) }],
    });
    const verdict = await salesXlsx.judge({ name: "produtos.xlsx", mime: "x", bytes: good });
    expect(failed(verdict.checks)).toEqual([]);
    expect(verdict.observations?.formulas).toBe(6);

    const bad = await make({
      format: "xlsx",
      name: "produtos.xlsx",
      sheets: [{ name: "Produtos", rows: rows(false, false) }],
    });
    const refused = await salesXlsx.judge({ name: "produtos.xlsx", mime: "x", bytes: bad });
    const names = failed(refused.checks);
    expect(names).toContain("o total de cada produto é fórmula (quantidade x preço)");
    expect(names).toContain("preços e totais em reais (formato com R$)");
  });
});

/** A 64 x 40 PNG of one colour, made with the standard library only. */
function tinyPng(): Uint8Array {
  const w = 64;
  const h = 40;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
