import { strFromU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createDocumentMaker } from "../src/index.js";
import { checkDocx } from "../src/verify-office.js";
import { checkPdf } from "../src/verify-pdf.js";
import { tagAttributes, tagTexts } from "../src/xml.js";
import { HISTORIA, PNG_1X1 } from "./fixtures.js";

const maker = createDocumentMaker({ author: "Bot Teste" });
const none = new Map<string, Uint8Array>();

/** pdf.js opened here by the test itself, independent of the maker's own check. */
async function readPdf(bytes: Uint8Array) {
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: string[] = [];
  const topNumbers: string[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
    // What is drawn above the top margin (3 cm = 85 pt from the top edge of an A4 page).
    topNumbers.push(
      content.items.flatMap((i) =>
        "str" in i && i.transform[5] > 841.89 - 85 && i.str.trim() !== "" ? [i.str] : [],
      ),
    );
  }
  const meta = await doc.getMetadata();
  return { numPages: doc.numPages, pages, topNumbers, info: meta.info as Record<string, unknown> };
}

async function made(request: Parameters<typeof maker.make>[0], images = none) {
  const result = await maker.make(request, images);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.document;
}

const LONG = Array.from(
  { length: 40 },
  (_, i) => `Parágrafo ${i + 1}: ${"A educação é o alicerce da cidadania. ".repeat(12)}`,
).join("\n\n");

describe("pdf", () => {
  it("padrao: title, author, accents, table and one page", async () => {
    const doc = await made({ format: "pdf", name: "h.pdf", style: "padrao", markdown: HISTORIA });
    expect(doc.mime).toBe("application/pdf");
    expect(doc.pages).toBe(1);
    expect(doc.title).toBe("História da PUCPR");
    const pdf = await readPdf(doc.bytes);
    expect(pdf.info.Title).toBe("História da PUCPR");
    expect(pdf.info.Author).toBe("Bot Teste");
    const text = pdf.pages[0] ?? "";
    expect(text).toContain("História da PUCPR");
    expect(text).toContain("acentuação, ç, ã, õ");
    expect(text).toContain("28.500");
    expect(text).toContain("Página 1 de 1");
    expect(doc.checks.join(" ")).toContain("all embedded");
  });

  it("academico: several pages, number only from page 2 at the top, justified ABNT text", async () => {
    const doc = await made({
      format: "pdf",
      name: "a.pdf",
      style: "academico",
      markdown: `# Relatório de pesquisa\n\n${LONG}`,
    });
    expect(doc.pages).toBeGreaterThan(2);
    const pdf = await readPdf(doc.bytes);
    expect(pdf.pages[0]).toContain("RELATÓRIO DE PESQUISA");
    expect(pdf.pages[0]).not.toContain("Página");
    expect(pdf.topNumbers[0]).toEqual([]);
    expect(pdf.topNumbers[1]).toEqual(["2"]);
    expect(pdf.topNumbers[2]).toEqual(["3"]);
    expect(pdf.numPages).toBe(doc.pages);
  });

  it("a given title is stored and shown when the content has no first heading", async () => {
    const doc = await made({
      format: "pdf",
      name: "t.pdf",
      style: "padrao",
      title: "Ata da reunião",
      markdown: "Decidimos **adiar** a obra.",
    });
    expect(doc.title).toBe("Ata da reunião");
    const pdf = await readPdf(doc.bytes);
    expect(pdf.info.Title).toBe("Ata da reunião");
    expect(pdf.pages[0]).toContain("Ata da reunião");
  });

  it("figure caption sits under the image with its source", async () => {
    const doc = await made(
      {
        format: "pdf",
        name: "f.pdf",
        style: "academico",
        markdown: '# Fig\n\n![Fachada do campus](fig/campus.png "Acervo da instituição")',
      },
      new Map([["fig/campus.png", PNG_1X1]]),
    );
    const pdf = await readPdf(doc.bytes);
    expect(pdf.pages[0]).toContain("Figura 1: Fachada do campus. Fonte: Acervo da instituição.");
  });

  it("an explicit page break starts a new page", async () => {
    const doc = await made({
      format: "pdf",
      name: "p.pdf",
      style: "padrao",
      markdown: "# A\n\num\n\n<!-- pagebreak -->\n\ndois",
    });
    expect(doc.pages).toBe(2);
  });
});

describe("docx", () => {
  it("padrao: A4, margins, title, accents, table, embedded font", async () => {
    const doc = await made({ format: "docx", name: "h.docx", style: "padrao", markdown: HISTORIA });
    const files = unzipSync(doc.bytes);
    const xml = strFromU8(files["word/document.xml"] ?? new Uint8Array());
    expect(tagAttributes(xml, "w:pgSz")[0]).toMatchObject({ "w:w": "11906", "w:h": "16838" });
    expect(tagAttributes(xml, "w:pgMar")[0]).toMatchObject({ "w:top": "1247", "w:left": "1247" });
    const text = tagTexts(xml, "w:t").join("");
    expect(text).toContain("História da PUCPR");
    expect(text).toContain("acentuação, ç, ã, õ");
    expect(xml.split("<w:tbl>").length - 1).toBe(1);
    const core = strFromU8(files["docProps/core.xml"] ?? new Uint8Array());
    expect(tagTexts(core, "dc:title")).toEqual(["História da PUCPR"]);
    expect(tagTexts(core, "dc:creator")).toEqual(["Bot Teste"]);
    expect(Object.keys(files).some((n) => n.startsWith("word/fonts/"))).toBe(true);
  });

  it("academico: ABNT margins 3/2/2/3 cm, 1.5 spacing, 1.25 cm indent, justified", async () => {
    const doc = await made({
      format: "docx",
      name: "a.docx",
      style: "academico",
      markdown: HISTORIA,
    });
    const files = unzipSync(doc.bytes);
    const xml = strFromU8(files["word/document.xml"] ?? new Uint8Array());
    expect(tagAttributes(xml, "w:pgMar")[0]).toMatchObject({
      "w:top": "1701",
      "w:right": "1134",
      "w:bottom": "1134",
      "w:left": "1701",
    });
    expect(tagAttributes(xml, "w:spacing").some((a) => a["w:line"] === "360")).toBe(true);
    expect(tagAttributes(xml, "w:ind").some((a) => a["w:firstLine"] === "709")).toBe(true);
    expect(xml).toContain('<w:jc w:val="both"/>');
    const styles = strFromU8(files["word/styles.xml"] ?? new Uint8Array());
    expect(tagAttributes(styles, "w:sz").some((a) => a["w:val"] === "24")).toBe(true);
  });
});

describe("xlsx", () => {
  it("keeps formulas, the real currency format, bold header, widths, A4 and the title", async () => {
    const doc = await made({
      format: "xlsx",
      name: "v.xlsx",
      title: "Vendas de março",
      sheets: [
        {
          name: "Vendas",
          rows: [
            ["Produto", "Preço", "Quantidade"],
            ["Café", { value: 12.5, format: "currency" }, 3],
            ["Pão de queijo", { value: 4, format: "currency" }, 10],
            [
              "Total",
              { formula: "=SUM(B2:B3)", format: "currency", bold: true },
              { formula: "=SUM(C2:C3)" },
            ],
          ],
          columnWidths: [24, 14, 14],
        },
      ],
    });
    const files = unzipSync(doc.bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(tagTexts(sheet, "f")).toEqual(["SUM(B2:B3)", "SUM(C2:C3)"]);
    const styles = strFromU8(files["xl/styles.xml"] ?? new Uint8Array());
    expect(tagAttributes(styles, "numFmt").map((a) => a.formatCode)).toContain('"R$" #,##0.00');
    expect(styles).toContain("<b/>");
    expect(tagAttributes(sheet, "col").map((a) => a.width)).toEqual(["24", "14", "14"]);
    expect(tagAttributes(sheet, "pageSetup")[0]).toMatchObject({ paperSize: "9" });
    expect(sheet).toContain('state="frozen"');
    const strings = tagTexts(strFromU8(files["xl/sharedStrings.xml"] ?? new Uint8Array()), "t");
    expect(strings).toContain("Pão de queijo");
    const core = strFromU8(files["docProps/core.xml"] ?? new Uint8Array());
    expect(tagTexts(core, "dc:title")).toEqual(["Vendas de março"]);
    expect(tagTexts(core, "dc:creator")).toEqual(["Bot Teste"]);
  });

  it("text that looks like a formula stays text", async () => {
    const doc = await made({
      format: "xlsx",
      name: "t.xlsx",
      sheets: [{ rows: [["Nota"], ['=HYPERLINK("http://x")']] }],
    });
    const sheet = strFromU8(unzipSync(doc.bytes)["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(tagTexts(sheet, "f")).toEqual([]);
  });
});

describe("verification fails: nothing is delivered", () => {
  it("a PDF longer than maxPages", async () => {
    const result = await maker.make(
      {
        format: "pdf",
        name: "l.pdf",
        style: "padrao",
        maxPages: 1,
        markdown: `# Longo\n\n${LONG}`,
      },
      none,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/pages but at most 1/);
  });

  it("empty heading, placeholder, empty header cell and a missing image", async () => {
    const md = await maker.make(
      { format: "pdf", name: "e.pdf", style: "padrao", markdown: "# \n\nTODO\n\n![](a.png)" },
      none,
    );
    expect(md.ok).toBe(false);
    if (!md.ok) {
      expect(md.problems.join(" ")).toContain("heading is empty");
      expect(md.problems.join(" ")).toContain("placeholder");
      expect(md.problems.join(" ")).toContain("no description");
    }
    const missing = await maker.make(
      { format: "pdf", name: "e.pdf", style: "padrao", markdown: "![x](a.png)" },
      none,
    );
    expect(missing.ok).toBe(false);
    const xlsx = await maker.make(
      {
        format: "xlsx",
        name: "e.xlsx",
        sheets: [
          {
            rows: [
              ["A", ""],
              [1, { formula: "SUM(A1)" }],
            ],
          },
        ],
      },
      none,
    );
    expect(xlsx.ok).toBe(false);
    if (!xlsx.ok) expect(xlsx.problems.join(" ")).toMatch(/header has an empty cell/);
  });

  it("academico figure without a source", async () => {
    const result = await maker.make(
      { format: "pdf", name: "f.pdf", style: "academico", markdown: "![Fachada](a.png)" },
      new Map([["a.png", PNG_1X1]]),
    );
    expect(result.ok).toBe(false);
  });

  it("a docx whose page was changed to Letter fails the check of the file", async () => {
    const doc = await made({ format: "docx", name: "h.docx", style: "padrao", markdown: HISTORIA });
    const files = unzipSync(doc.bytes);
    const xml = strFromU8(files["word/document.xml"] ?? new Uint8Array()).replace(
      'w:w="11906"',
      'w:w="12240"',
    );
    files["word/document.xml"] = new TextEncoder().encode(xml);
    const check = checkDocx(zipSync(files), {
      title: "História da PUCPR",
      author: "Bot Teste",
      style: "padrao",
      texts: ["História da PUCPR"],
      tables: 1,
      figures: 0,
    });
    expect(check.problems.join(" ")).toContain("not A4");
  });

  it("a PDF that uses a font it does not embed fails the check", async () => {
    const stream = "BT /F1 12 Tf 72 700 Td (Ola mundo) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (T) /Author (A) >> >>\nstartxref\n${xref}\n%%EOF`;
    const check = await checkPdf(new TextEncoder().encode(pdf), {
      title: "T",
      author: "A",
      maxPages: undefined,
      texts: ["Ola mundo"],
      margins: { top: 0, bottom: 0 },
    });
    expect(check.problems.join(" ")).toContain("not embedded");
  });
});
