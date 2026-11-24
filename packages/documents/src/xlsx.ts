// Builds the Excel file with write-excel-file, then adds what the library has no option for by
// opening the ZIP again (fflate): the document properties (title, author), an A4 page setup with
// margins, and the header filter. Nothing the bot writes ever becomes a formula by accident: text
// is always text; a formula exists only in a cell the bot declared with `formula`.
import {
  CELL_FORMAT_CODES,
  MAX_SHEET_NAME_LENGTH,
  type SheetCell,
  type SheetInput,
} from "@suup/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import writeXlsxFile from "write-excel-file/node";

/** A4 in a spreadsheet is paper size 9; the margins are Excel's own defaults, in inches. */
export const XLSX_PAPER_A4 = "9";
export const XLSX_MARGINS = {
  left: "0.7",
  right: "0.7",
  top: "0.75",
  bottom: "0.75",
  header: "0.3",
  footer: "0.3",
};
/** A sheet wider than this many columns prints in landscape. */
const LANDSCAPE_FROM_COLUMNS = 7;
/** The characters Excel does not allow in a sheet name. */
const FORBIDDEN_IN_SHEET_NAME = [":", "\\", "/", "?", "*", "[", "]"];

export interface XlsxInput {
  sheets: SheetInput[];
  title: string;
  author: string;
}

export interface XlsxOutput {
  bytes: Uint8Array;
  /** Per sheet: the formulas and the formats it must keep, for the check of the file. */
  expected: {
    name: string;
    columns: number;
    formulas: string[];
    formats: string[];
    texts: string[];
    widths: number[];
  }[];
  notes: string[];
  problems: string[];
}

interface Cell {
  type?: "Formula";
  value?: string | number | boolean | null;
  format?: string;
  fontWeight?: "bold";
  backgroundColor?: string;
  textColor?: string;
  align?: "left" | "center" | "right";
  wrap?: boolean;
}

const HEADER_FILL = "#2f4b7c";

export function sheetName(raw: string | undefined, index: number): { name: string; note?: string } {
  const fallback = `Planilha ${index + 1}`;
  let name = raw?.trim() ?? "";
  if (name === "") return { name: fallback };
  let changed = false;
  for (const ch of FORBIDDEN_IN_SHEET_NAME) {
    if (name.includes(ch)) {
      name = name.split(ch).join(" ");
      changed = true;
    }
  }
  name = name.trim();
  if (name.startsWith("'") || name.endsWith("'")) {
    name = name.split("'").join("").trim();
    changed = true;
  }
  if (name.length > MAX_SHEET_NAME_LENGTH) {
    name = name.slice(0, MAX_SHEET_NAME_LENGTH).trimEnd();
    changed = true;
  }
  if (name === "") return { name: fallback };
  return changed
    ? {
        name,
        note: `Sheet name ${JSON.stringify(raw)} was changed to ${JSON.stringify(name)} (Excel allows 31 characters and no : \\ / ? * [ ]).`,
      }
    : { name };
}

/** Parentheses that open and close in the formula, outside the "text" parts. */
function balanced(formula: string): boolean {
  let depth = 0;
  let inText = false;
  for (const ch of formula) {
    if (ch === '"') inText = !inText;
    else if (!inText && ch === "(") depth += 1;
    else if (!inText && ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !inText;
}

export async function buildXlsx(input: XlsxInput): Promise<XlsxOutput> {
  const problems: string[] = [];
  const notes: string[] = [];
  const expected: XlsxOutput["expected"] = [];
  const seen = new Set<string>();
  const sheets = input.sheets.map((sheet, index) => {
    const named = sheetName(sheet.name, index);
    if (named.note !== undefined) notes.push(named.note);
    const key = named.name.toLowerCase();
    if (seen.has(key)) {
      problems.push(
        `Two sheets are named ${JSON.stringify(named.name)}: give each sheet its own name.`,
      );
    }
    seen.add(key);
    const label = `Sheet ${JSON.stringify(named.name)}`;
    const header = sheet.rows[0] ?? [];
    const width = header.length;
    const info: XlsxOutput["expected"][number] = {
      name: named.name,
      columns: width,
      formulas: [],
      formats: [],
      texts: [],
      widths: [],
    };
    if (width === 0 || header.every((c) => c === null || c === "")) {
      problems.push(`${label}: the first row is the header and it is empty. Name every column.`);
    } else if (header.some((c) => c === null || c === "")) {
      problems.push(`${label}: the header has an empty cell. Name every column.`);
    }
    const data = sheet.rows.map((row, r): Cell[] => {
      if (row.length > width) {
        problems.push(
          `${label}: row ${r + 1} has ${row.length} cells but the header has ${width}.`,
        );
      }
      return row.map((raw: SheetCell, c): Cell => {
        const cell = convertCell(raw, r === 0, label, `${columnLetter(c)}${r + 1}`, problems, info);
        return cell;
      });
    });
    const widths = Array.from({ length: width }, (_, c) => {
      const given = sheet.columnWidths?.[c];
      if (given !== undefined) return given;
      let longest = 8;
      for (const row of sheet.rows) {
        const raw = row[c];
        const text =
          raw === null || raw === undefined
            ? ""
            : typeof raw === "object"
              ? raw.formula !== undefined
                ? "0000000000"
                : String(raw.value ?? "")
              : typeof raw === "number"
                ? raw.toLocaleString("pt-BR", { minimumFractionDigits: 2 })
                : String(raw);
        longest = Math.max(longest, [...text].length + 3);
      }
      return Math.min(longest, 60);
    });
    info.widths = widths;
    expected.push(info);
    return {
      sheet: named.name,
      data,
      columns: widths.map((w) => ({ width: w })),
      stickyRowsCount: 1,
      ...(width >= LANDSCAPE_FROM_COLUMNS ? { orientation: "landscape" as const } : {}),
    };
  });
  if (problems.length > 0) {
    return { bytes: new Uint8Array(), expected, notes, problems };
  }
  const raw = await (
    writeXlsxFile(sheets as never, { fontFamily: "Calibri", fontSize: 11 }) as {
      toBuffer(): Promise<Uint8Array>;
    }
  ).toBuffer();
  const bytes = finish(new Uint8Array(raw), input, expected);
  return { bytes, expected, notes, problems };
}

function convertCell(
  raw: SheetCell,
  header: boolean,
  label: string,
  where: string,
  problems: string[],
  info: XlsxOutput["expected"][number],
): Cell {
  const base: Cell = header
    ? { fontWeight: "bold", backgroundColor: HEADER_FILL, textColor: "#ffffff", wrap: true }
    : {};
  if (raw === null) return { ...base, value: null };
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    if (typeof raw === "string") info.texts.push(raw);
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      problems.push(`${label}: ${where} is not a finite number.`);
    }
    return { ...base, value: raw };
  }
  const format = raw.format === undefined ? undefined : CELL_FORMAT_CODES[raw.format];
  if (format !== undefined && !info.formats.includes(format)) info.formats.push(format);
  const common: Cell = {
    ...base,
    ...(format === undefined ? {} : { format }),
    ...(raw.bold === true ? { fontWeight: "bold" as const } : {}),
  };
  if (raw.formula !== undefined) {
    const formula = raw.formula.trim();
    if (!formula.startsWith("=") || formula.length < 2) {
      problems.push(
        `${label}: the formula in ${where} must start with "=" (for example "=SUM(B2:B9)").`,
      );
    } else if (!balanced(formula)) {
      problems.push(`${label}: the formula in ${where} has unbalanced parentheses or quotes.`);
    }
    // In the file a formula has no leading "=".
    const stored = formula.startsWith("=") ? formula.slice(1) : formula;
    info.formulas.push(stored);
    return { ...common, type: "Formula", value: stored };
  }
  if (typeof raw.value === "string") info.texts.push(raw.value);
  if (typeof raw.value === "number" && !Number.isFinite(raw.value)) {
    problems.push(`${label}: ${where} is not a finite number.`);
  }
  return { ...common, value: raw.value ?? null };
}

function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Inserts `add` right before the first `marker` in `xml`; the file is Suup's own, so it is found. */
function insertBefore(xml: string, marker: string, add: string): string {
  const at = xml.indexOf(marker);
  return at === -1 ? xml : xml.slice(0, at) + add + xml.slice(at);
}

function escapeXml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;");
}

function finish(zip: Uint8Array, input: XlsxInput, expected: XlsxOutput["expected"]): Uint8Array {
  const files = unzipSync(zip);
  const text = (name: string): string => strFromU8(files[name] ?? new Uint8Array());
  const put = (name: string, xml: string): void => {
    files[name] = strToU8(xml);
  };
  // Document properties.
  const now = new Date().toISOString().slice(0, 19);
  put(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(input.title)}</dc:title><dc:creator>${escapeXml(input.author)}</dc:creator><cp:lastModifiedBy>${escapeXml(input.author)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}Z</dcterms:modified></cp:coreProperties>`,
  );
  put(
    "[Content_Types].xml",
    insertBefore(
      text("[Content_Types].xml"),
      "</Types>",
      '<Override ContentType="application/vnd.openxmlformats-package.core-properties+xml" PartName="/docProps/core.xml"/>',
    ),
  );
  put(
    "_rels/.rels",
    insertBefore(
      text("_rels/.rels"),
      "</Relationships>",
      '<Relationship Id="rId-core-1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    ),
  );
  // Page setup and the filter of each sheet.
  expected.forEach((sheet, i) => {
    const file = `xl/worksheets/sheet${i + 1}.xml`;
    let xml = text(file);
    const lastColumn = columnLetter(Math.max(sheet.columns, 1) - 1);
    const landscape = sheet.columns >= LANDSCAPE_FROM_COLUMNS;
    xml = insertBefore(xml, "<sheetViews", '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    const m = XLSX_MARGINS;
    xml = insertBefore(
      xml,
      "</worksheet>",
      `<autoFilter ref="A1:${lastColumn}1"/><pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="${m.header}" footer="${m.footer}"/><pageSetup paperSize="${XLSX_PAPER_A4}" orientation="${landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>`,
    );
    put(file, xml);
  });
  return zipSync(files);
}
