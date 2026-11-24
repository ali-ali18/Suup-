import { DOCUMENT_MIME } from "@suup/core";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDocumentMaker, inspectDelivery } from "../src/index.js";
import { HISTORIA, PNG_1X1 } from "./fixtures.js";

const maker = createDocumentMaker({ author: "Bot Teste" });
const none = new Map<string, Uint8Array>();

/** A one-page PDF written by hand: `font` is not embedded (one of the 14 standard fonts). */
function handPdf(width: number, height: number): Uint8Array {
  const text = "BT /F1 12 Tf 72 700 Td (Ola mundo) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

function docxWith(pgSz: string, pgMar: string, fonts = "Arial"): Uint8Array {
  const document = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="${fonts}" w:hAnsi="${fonts}"/></w:rPr><w:t>Olá mundo</w:t></w:r></w:p><w:sectPr>${pgSz}${pgMar}</w:sectPr></w:body></w:document>`;
  return zipSync({
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8("<w:styles/>"),
  });
}

const A4 = '<w:pgSz w:w="11906" w:h="16838"/>';
const LETTER = '<w:pgSz w:w="12240" w:h="15840"/>';
const MARGINS = '<w:pgMar w:top="1417" w:right="1134" w:bottom="1134" w:left="1701"/>';

async function xlsxBytes(sheet: unknown[][]): Promise<Uint8Array> {
  const result = await maker.make(
    { format: "xlsx", name: "p.xlsx", sheets: [{ rows: sheet as never }] },
    none,
  );
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.document.bytes;
}

describe("inspectDelivery: PDF", () => {
  it("a file made by create_document passes and reports what was measured (M9)", async () => {
    const result = await maker.make(
      { format: "pdf", name: "h.pdf", style: "padrao", markdown: HISTORIA },
      none,
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    // The tool hands the same facts to the bot.
    expect(result.document.facts.join(" | ")).toContain("PDF, 1 page, 210 x 297 mm (A4)");
    expect(result.document.facts.join(" | ")).toContain("fonts embedded: Geist");
    const report = await inspectDelivery({ bytes: result.document.bytes, mime: DOCUMENT_MIME.pdf });
    expect(report?.problems).toEqual([]);
    expect(report?.facts.join(" | ")).toContain("closest the text comes to the edge");
  });

  it("the ABNT style is measured: 12 pt and the 3/2/2/3 cm margins", async () => {
    const body = Array.from({ length: 12 }, () =>
      "A educação é o alicerce da cidadania. ".repeat(14),
    ).join("\n\n");
    const result = await maker.make(
      { format: "pdf", name: "a.pdf", style: "academico", markdown: `# Trabalho\n\n${body}` },
      none,
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    const facts = result.document.facts.join(" | ");
    expect(facts).toContain("body text 12 pt");
    expect(facts).toContain("(left/right/top/bottom): 3/2/");
  });

  it("refuses a PDF whose font is not embedded", async () => {
    const report = await inspectDelivery({
      bytes: handPdf(595.28, 841.89),
      mime: DOCUMENT_MIME.pdf,
    });
    expect(report?.problems.join(" ")).toContain("The font is not embedded in the PDF");
    expect(report?.problems.join(" ")).toContain("(not carried: Helvetica)");
  });

  it("refuses a page that is not A4", async () => {
    const report = await inspectDelivery({ bytes: handPdf(612, 792), mime: DOCUMENT_MIME.pdf });
    expect(report?.problems.join(" ")).toContain("The page is not A4: it measures 216 x 279 mm");
  });

  it("refuses a file that is not a PDF at all", async () => {
    const report = await inspectDelivery({
      bytes: new Uint8Array([1, 2, 3]),
      mime: DOCUMENT_MIME.pdf,
    });
    expect(report?.problems[0]).toContain("does not open");
  });

  it("another type is not checked", async () => {
    expect(await inspectDelivery({ bytes: PNG_1X1, mime: "image/png" })).toBeNull();
  });
});

describe("inspectDelivery: docx", () => {
  it("a file made by create_document passes", async () => {
    const result = await maker.make(
      { format: "docx", name: "h.docx", style: "academico", markdown: HISTORIA },
      none,
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    const report = await inspectDelivery({
      bytes: result.document.bytes,
      mime: DOCUMENT_MIME.docx,
    });
    expect(report?.problems).toEqual([]);
    expect(report?.facts.join(" | ")).toContain("margins (top/right/bottom/left): 3/2/2/3 cm");
  });

  it("an A4 file with sensible margins and a font Word ships passes", async () => {
    const report = await inspectDelivery({
      bytes: docxWith(A4, MARGINS),
      mime: DOCUMENT_MIME.docx,
    });
    expect(report?.problems).toEqual([]);
  });

  it("refuses Letter, tiny margins and an unknown font that is not embedded", async () => {
    const report = await inspectDelivery({
      bytes: docxWith(
        LETTER,
        '<w:pgMar w:top="100" w:right="100" w:bottom="100" w:left="100"/>',
        "Fonte Rara",
      ),
      mime: DOCUMENT_MIME.docx,
    });
    const text = report?.problems.join("\n") ?? "";
    expect(text).toContain("The page is not A4");
    expect(text).toContain("The margins are not sensible");
    expect(text).toContain('"Fonte Rara" is not embedded');
  });
});

describe("inspectDelivery: xlsx", () => {
  it("a sheet from create_document passes", async () => {
    const bytes = await xlsxBytes([
      ["Produto", "Preço", "Total"],
      ["Caneta", { value: 2.5, format: "currency" }, { formula: "=B2*2", format: "currency" }],
    ]);
    const report = await inspectDelivery({ bytes, mime: DOCUMENT_MIME.xlsx });
    expect(report?.problems).toEqual([]);
    expect(report?.facts.join(" | ")).toContain("1 formula(s)");
  });

  it("refuses numbers as text, formulas with no format and error formulas", async () => {
    const bytes = await xlsxBytes([
      ["Produto", "Preço", "Total"],
      ["Caneta", "R$ 2,50", { formula: "=A9*2" }],
      ["Lápis", 1.25, { formula: "=#REF!+1" }],
    ]);
    const text =
      (await inspectDelivery({ bytes, mime: DOCUMENT_MIME.xlsx }))?.problems.join("\n") ?? "";
    expect(text).toContain("numbers stored as text in B2");
    expect(text).toContain("without a number format");
    expect(text).toContain("formulas with errors");
  });
});

describe("inspectDelivery: a Word file from a template", () => {
  it("fonts the Normal style uses count; fonts of unused template styles do not", () => {
    const styles =
      '<w:styles><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:styleId="Normal"><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:pPr><w:spacing w:line="360"/><w:jc w:val="both"/></w:pPr></w:style><w:style w:styleId="Code"><w:rPr><w:rFonts w:ascii="Courier"/></w:rPr></w:style></w:styles>';
    const document = `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Olá</w:t></w:r></w:p><w:sectPr>${A4}${MARGINS}</w:sectPr></w:body></w:document>`;
    const bytes = zipSync({
      "word/document.xml": strToU8(document),
      "word/styles.xml": strToU8(styles),
    });
    return inspectDelivery({ bytes, mime: DOCUMENT_MIME.docx }).then((report) => {
      expect(report?.problems).toEqual([]);
      expect(report?.facts.join(" | ")).toContain(
        "Normal style: 12 pt, line spacing 1.5, justified",
      );
    });
  });
});
