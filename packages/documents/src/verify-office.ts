// Opens the built docx or xlsx again (it is a ZIP of XML) and checks what must have survived.

import type { DocumentStyle } from "@suup/core";
import { strFromU8, unzipSync } from "fflate";
import { A4_TWIPS, LOOKS } from "./style.js";
import { squash } from "./verify-pdf.js";
import { XLSX_MARGINS, XLSX_PAPER_A4, type XlsxOutput } from "./xlsx.js";
import { countTags, tagAttributes, tagTexts } from "./xml.js";

export interface OfficeCheck {
  checks: string[];
  problems: string[];
}

function read(files: Record<string, Uint8Array>, name: string): string | undefined {
  const file = files[name];
  return file === undefined ? undefined : strFromU8(file);
}

function open(bytes: Uint8Array): Record<string, Uint8Array> | undefined {
  try {
    return unzipSync(bytes);
  } catch {
    return undefined;
  }
}

export function checkDocx(
  bytes: Uint8Array,
  expect: {
    title: string;
    author: string;
    style: DocumentStyle;
    texts: string[];
    tables: number;
    figures: number;
  },
): OfficeCheck {
  const problems: string[] = [];
  const checks: string[] = [];
  const files = open(bytes);
  const xml = files === undefined ? undefined : read(files, "word/document.xml");
  if (files === undefined || xml === undefined) {
    return { checks, problems: ["The Word file is not a valid ZIP with word/document.xml."] };
  }
  const size = tagAttributes(xml, "w:pgSz")[0];
  if (size?.["w:w"] !== String(A4_TWIPS.width) || size?.["w:h"] !== String(A4_TWIPS.height)) {
    problems.push("The Word page is not A4 (11906 x 16838).");
  } else {
    checks.push("A4 page size in the XML");
  }
  const look = LOOKS[expect.style];
  const want = {
    "w:top": Math.round(look.margin.top * 567),
    "w:right": Math.round(look.margin.right * 567),
    "w:bottom": Math.round(look.margin.bottom * 567),
    "w:left": Math.round(look.margin.left * 567),
  };
  const mar = tagAttributes(xml, "w:pgMar")[0];
  const wrongMargin = Object.entries(want).filter(([k, v]) => mar?.[k] !== String(v));
  if (mar === undefined || wrongMargin.length > 0) {
    problems.push(`The Word margins are not the ones of the ${expect.style} style.`);
  } else {
    checks.push(
      `margins ${look.margin.top}/${look.margin.right}/${look.margin.bottom}/${look.margin.left} cm`,
    );
  }
  const core = read(files, "docProps/core.xml") ?? "";
  if (
    !tagTexts(core, "dc:title").includes(expect.title) ||
    !tagTexts(core, "dc:creator").includes(expect.author)
  ) {
    problems.push("The Word title or author did not survive in the file properties.");
  } else {
    checks.push("title and author in the properties");
  }
  const embedded = Object.keys(files).filter((n) => n.startsWith("word/fonts/")).length;
  if (embedded === 0) problems.push("The font is not embedded in the Word file.");
  else checks.push(`${embedded} font files embedded`);
  const flat = squash(tagTexts(xml, "w:t").join(""));
  const lost = expect.texts.filter((t) => squash(t) !== "" && !flat.includes(squash(t)));
  if (lost.length > 0) {
    problems.push(
      `Text missing from the Word file: ${lost
        .slice(0, 3)
        .map((t) => JSON.stringify(t.slice(0, 50)))
        .join(", ")}.`,
    );
  } else {
    checks.push("text with accents intact");
  }
  if (countTags(xml, "w:tbl") !== expect.tables)
    problems.push("A table did not reach the Word file.");
  else if (expect.tables > 0) checks.push(`${expect.tables} table(s)`);
  if (countTags(xml, "w:drawing") !== expect.figures)
    problems.push("An image did not reach the Word file.");
  return { checks, problems };
}

export function checkXlsx(
  bytes: Uint8Array,
  expect: { title: string; author: string; sheets: XlsxOutput["expected"] },
): OfficeCheck {
  const problems: string[] = [];
  const checks: string[] = [];
  const files = open(bytes);
  if (files === undefined) return { checks, problems: ["The Excel file is not a valid ZIP."] };
  const workbook = read(files, "xl/workbook.xml") ?? "";
  const names = tagAttributes(workbook, "sheet").map((a) => a.name);
  if (names.join("\u0000") !== expect.sheets.map((s) => s.name).join("\u0000")) {
    problems.push("The sheet names did not survive in the Excel file.");
  } else {
    checks.push(`${names.length} sheet(s)`);
  }
  const core = read(files, "docProps/core.xml") ?? "";
  if (
    !tagTexts(core, "dc:title").includes(expect.title) ||
    !tagTexts(core, "dc:creator").includes(expect.author)
  ) {
    problems.push("The Excel title or author did not survive in the file properties.");
  } else {
    checks.push("title and author in the properties");
  }
  const styles = read(files, "xl/styles.xml") ?? "";
  const codes = tagAttributes(styles, "numFmt").map((a) => a.formatCode);
  const strings = tagTexts(read(files, "xl/sharedStrings.xml") ?? "", "t").join("\u0000");
  let formulaCount = 0;
  expect.sheets.forEach((sheet, i) => {
    const xml = read(files, `xl/worksheets/sheet${i + 1}.xml`) ?? "";
    const found = tagTexts(xml, "f");
    for (const f of sheet.formulas) {
      if (!found.includes(f))
        problems.push(`The formula =${f} did not survive in sheet ${JSON.stringify(sheet.name)}.`);
    }
    formulaCount += sheet.formulas.length;
    if (found.length !== sheet.formulas.length) {
      problems.push(`Sheet ${JSON.stringify(sheet.name)} has a formula that was not asked for.`);
    }
    for (const format of sheet.formats) {
      if (!codes.includes(format)) problems.push(`The number format ${format} did not survive.`);
    }
    const size = tagAttributes(xml, "pageSetup")[0];
    const margins = tagAttributes(xml, "pageMargins")[0];
    if (size?.paperSize !== XLSX_PAPER_A4)
      problems.push(`Sheet ${JSON.stringify(sheet.name)} is not set to A4.`);
    if (
      margins?.left !== XLSX_MARGINS.left ||
      margins?.right !== XLSX_MARGINS.right ||
      margins?.top !== XLSX_MARGINS.top ||
      margins?.bottom !== XLSX_MARGINS.bottom
    ) {
      problems.push(`Sheet ${JSON.stringify(sheet.name)} lost its page margins.`);
    }
    const cols = tagAttributes(xml, "col");
    if (cols.length !== sheet.columns)
      problems.push(`Sheet ${JSON.stringify(sheet.name)} lost column widths.`);
    for (const t of sheet.texts) {
      if (!strings.includes(t)) {
        problems.push(
          `The text ${JSON.stringify(t.slice(0, 40))} did not reach sheet ${JSON.stringify(sheet.name)}.`,
        );
        break;
      }
    }
    if (!xml.includes('state="frozen"'))
      problems.push(`Sheet ${JSON.stringify(sheet.name)} lost its frozen header.`);
  });
  if (!styles.includes("<b/>")) problems.push("The header row is not bold in the Excel file.");
  checks.push("A4 and margins in the XML", "header bold and frozen", "column widths");
  if (formulaCount > 0) checks.push(`${formulaCount} formula(s) kept`);
  const formats = expect.sheets.reduce((n, s) => n + s.formats.length, 0);
  if (formats > 0) checks.push("number formats kept");
  return { checks, problems };
}
