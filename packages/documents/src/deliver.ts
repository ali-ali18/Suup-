// The check every PDF, Word and Excel file passes before it reaches the user, whoever made it (a
// script the bot wrote or `create_document`): the file is opened again as a reader would, and what
// is measured comes back as problems (the bot fixes them and sends again) and facts (what a
// reviewer can quote). The type is the one `detectFileType` decided from the signature and the
// extension; nothing here guesses a type from a pattern. English, because the bot reads it.
import { type DeliveryReport, DOCUMENT_MIME } from "@suup/core";
import { strFromU8, unzipSync } from "fflate";
import { inspectPdf, inspectXlsx, type XlsxCell } from "./inspect.js";
import { measureLayout } from "./measure.js";
import { A4_TWIPS } from "./style.js";
import { tagAttributes, tagTexts } from "./xml.js";

/** The smallest margin that reads as a margin, in cm (text closer to the edge may be cut when printed). */
const MIN_SIDE_CM = 1.5;
const MIN_TOP_BOTTOM_CM = 1;
/** Word's margin unit: twentieths of a point; 567 per cm. */
const TWIPS_PER_CM = 567;
const TWIPS_TOLERANCE = 30;

const FIX_FONT =
  'The 14 standard fonts (Helvetica, Times, Courier) are not carried by the file. Register a TrueType font and use it in EVERY style, table cell and bold or italic variant: with reportlab, `pdfmetrics.registerFont(TTFont("Body", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"))` (also the -Bold, -Italic and -BoldItalic files, plus `registerFontFamily`), or simply `import suup_docs` and use `suup_docs.pdf(...)`.';

/** Fonts Word and LibreOffice ship, so a .docx that names one does not need to carry it. */
const SHIPPED_FONTS: ReadonlySet<string> = new Set([
  "Calibri",
  "Calibri Light",
  "Cambria",
  "Cambria Math",
  "Arial",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Trebuchet MS",
  "Segoe UI",
  "Consolas",
  "Aptos",
  "Aptos Display",
  "Symbol",
  "Wingdings",
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "Carlito",
  "Caladea",
]);

const mm = (points: number): number => Math.round((points / 72) * 25.4);

export async function inspectDelivery(file: {
  bytes: Uint8Array;
  mime: string;
}): Promise<DeliveryReport | null> {
  if (file.mime === DOCUMENT_MIME.pdf) return pdfReport(file.bytes);
  if (file.mime === DOCUMENT_MIME.docx) return docxReport(file.bytes);
  if (file.mime === DOCUMENT_MIME.xlsx) return xlsxReport(file.bytes);
  return null;
}

async function pdfReport(bytes: Uint8Array): Promise<DeliveryReport> {
  let pdf: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    pdf = await inspectPdf(bytes);
  } catch {
    return { problems: ["The PDF does not open: it is damaged or not a PDF."], facts: [] };
  }
  const problems: string[] = [];
  if (pdf.pages < 1) problems.push("The PDF has no pages.");
  if (!pdf.allA4) {
    problems.push(
      `The page is not A4: it measures ${mm(pdf.pageSize.width)} x ${mm(pdf.pageSize.height)} mm (A4 is 210 x 297 mm). Make every page A4, or use \`force\` if the user asked for another size.`,
    );
  }
  if (pdf.missingFonts.length > 0 || pdf.fonts.length === 0) {
    const which = pdf.missingFontNames.filter((n) => n !== "").join(", ");
    problems.push(
      `The font is not embedded in the PDF${which === "" ? "" : ` (not carried: ${which})`}. ${FIX_FONT}`,
    );
  }
  if (pdf.brokenText) {
    problems.push(
      "The text has broken characters (the replacement character): the font lacks some letters. Use a font with full Portuguese coverage.",
    );
  }
  const facts = [
    `PDF, ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}, ${mm(pdf.pageSize.width)} x ${mm(pdf.pageSize.height)} mm${pdf.allA4 ? " (A4)" : ""}`,
    `fonts embedded: ${pdf.fontNames.length === 0 ? "none" : pdf.fontNames.join(", ")}`,
  ];
  const layout = measureLayout(pdf);
  if (layout.fontSize > 0) {
    facts.push(
      `body text ${layout.fontSize} pt, line spacing ${layout.lineSpacing || "n/a"}, ${Math.round(layout.justifiedShare * 100)}% of lines justified`,
      `closest the text comes to the edge, measured in the file (left/right/top/bottom): ${layout.leftCm}/${layout.rightCm}/${layout.topCm}/${layout.bottomCm} cm`,
    );
    const tight: string[] = [];
    if (layout.leftCm < MIN_SIDE_CM) tight.push(`left ${layout.leftCm} cm`);
    if (layout.rightCm < MIN_SIDE_CM) tight.push(`right ${layout.rightCm} cm`);
    if (layout.topCm < MIN_TOP_BOTTOM_CM) tight.push(`top ${layout.topCm} cm`);
    if (layout.bottomCm < MIN_TOP_BOTTOM_CM) tight.push(`bottom ${layout.bottomCm} cm`);
    if (tight.length > 0) {
      problems.push(
        `The margins are too small (${tight.join(", ")}): the text nearly touches the edge. Use at least ${MIN_SIDE_CM} cm at the sides and ${MIN_TOP_BOTTOM_CM} cm at the top and bottom (ABNT: 3 cm left and top, 2 cm right and bottom).`,
      );
    }
  }
  if (pdf.images > 0) facts.push(`${pdf.images} image(s)`);
  if (pdf.title !== null && pdf.title !== "") facts.push(`title: ${pdf.title}`);
  return { problems, facts };
}

function docxReport(bytes: Uint8Array): DeliveryReport {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { problems: ["The Word file does not open: it is not a valid .docx."], facts: [] };
  }
  const read = (name: string): string => {
    const f = files[name];
    return f === undefined ? "" : strFromU8(f);
  };
  const xml = read("word/document.xml");
  if (xml === "") {
    return {
      problems: ["The Word file has no word/document.xml: it is not a valid .docx."],
      facts: [],
    };
  }
  const problems: string[] = [];
  const facts: string[] = [];
  // Every section: a document can change size or margins midway.
  const sizes = tagAttributes(xml, "w:pgSz");
  const margins = tagAttributes(xml, "w:pgMar");
  const portrait = (w: number, h: number): boolean =>
    Math.abs(w - A4_TWIPS.width) <= TWIPS_TOLERANCE &&
    Math.abs(h - A4_TWIPS.height) <= TWIPS_TOLERANCE;
  const wrong = sizes.filter((s) => {
    const w = Number(s["w:w"]);
    const h = Number(s["w:h"]);
    return !(portrait(w, h) || portrait(h, w));
  });
  if (sizes.length === 0) {
    problems.push("The page is not A4: the file does not set a page size (Word would use Letter).");
  } else if (wrong.length > 0) {
    const first = wrong[0];
    problems.push(
      `The page is not A4: it measures ${cmOfTwips(Number(first?.["w:w"]))} x ${cmOfTwips(Number(first?.["w:h"]))} cm (A4 is 21 x 29.7 cm). Set the section's page size to A4, or use \`force\` if the user asked for another size.`,
    );
  } else {
    facts.push("A4 page size set in the file");
  }
  const m = margins[0];
  if (m === undefined) {
    problems.push("The file does not set page margins.");
  } else {
    const side = (k: string): number => Number(m[k]) / TWIPS_PER_CM;
    const [top, right, bottom, left] = [
      side("w:top"),
      side("w:right"),
      side("w:bottom"),
      side("w:left"),
    ];
    const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
    facts.push(
      `margins (top/right/bottom/left): ${fmt(top)}/${fmt(right)}/${fmt(bottom)}/${fmt(left)} cm`,
    );
    const tight: string[] = [];
    if (left < MIN_SIDE_CM) tight.push(`left ${fmt(left)} cm`);
    if (right < MIN_SIDE_CM) tight.push(`right ${fmt(right)} cm`);
    if (top < MIN_TOP_BOTTOM_CM) tight.push(`top ${fmt(top)} cm`);
    if (bottom < MIN_TOP_BOTTOM_CM) tight.push(`bottom ${fmt(bottom)} cm`);
    if (tight.length > 0 || [top, right, bottom, left].some(Number.isNaN)) {
      problems.push(
        `The margins are not sensible (${tight.join(", ") || "unreadable"}). Use at least ${MIN_SIDE_CM} cm at the sides and ${MIN_TOP_BOTTOM_CM} cm at the top and bottom (ABNT: 3/2/2/3 cm).`,
      );
    }
  }
  // Fonts: the ones named in the text, in the document defaults and in the Normal style (the
  // other styles of a template name fonts nobody uses, such as Courier for code).
  const styles = read("word/styles.xml");
  const defaults = between(styles, "<w:docDefaults", "</w:docDefaults>");
  const normalAt = styles.indexOf('w:styleId="Normal"');
  const normal = normalAt === -1 ? "" : between(styles.slice(normalAt), ">", "</w:style>");
  const named = new Set<string>();
  for (const part of [xml, defaults, normal]) {
    for (const a of tagAttributes(part, "w:rFonts")) {
      for (const key of ["w:ascii", "w:hAnsi", "w:cs"]) {
        const v = a[key];
        if (v !== undefined && v !== "") named.add(v);
      }
    }
  }
  const carried = Object.keys(files).filter((n) => n.startsWith("word/fonts/")).length;
  const loose = [...named].filter((f) => !SHIPPED_FONTS.has(f));
  if (carried === 0 && loose.length > 0) {
    problems.push(
      `The font ${loose.map((f) => JSON.stringify(f)).join(", ")} is not embedded in the Word file and Word does not ship it, so another computer would swap it. Embed it, or use a font Word ships (Calibri, Arial, Times New Roman, Cambria).`,
    );
  }
  facts.push(
    `fonts: ${named.size === 0 ? "the default of the template" : [...named].join(", ")}${carried > 0 ? `; ${carried} font file(s) embedded` : ""}`,
  );
  const size =
    tagAttributes(normal, "w:sz")[0]?.["w:val"] ?? tagAttributes(defaults, "w:sz")[0]?.["w:val"];
  const line = tagAttributes(normal, "w:spacing")[0]?.["w:line"];
  const justified = tagAttributes(normal, "w:jc")[0]?.["w:val"] === "both";
  const look = [
    size !== undefined && Number.isFinite(Number(size)) ? `${Number(size) / 2} pt` : "",
    line !== undefined && Number.isFinite(Number(line)) ? `line spacing ${Number(line) / 240}` : "",
    justified ? "justified" : "",
  ].filter((t) => t !== "");
  if (look.length > 0) facts.push(`Normal style: ${look.join(", ")}`);
  const words = tagTexts(xml, "w:t")
    .join(" ")
    .split(" ")
    .filter((w) => w.trim() !== "").length;
  if (words === 0) problems.push("The Word document has no text.");
  facts.push(
    `${words} words, ${tagAttributes(xml, "w:tbl").length} table(s), ${tagAttributes(xml, "w:drawing").length} image(s); Word paginates when it opens the file, so the page count is not known`,
  );
  return { problems, facts };
}

/** The text of `xml` from the first `from` to the next `to` after it ("" when either is missing). */
function between(xml: string, from: string, to: string): string {
  const at = xml.indexOf(from);
  if (at === -1) return "";
  const end = xml.indexOf(to, at);
  return end === -1 ? "" : xml.slice(at, end);
}

function cmOfTwips(twips: number): number {
  return Math.round((twips / TWIPS_PER_CM) * 10) / 10;
}

/** What Excel shows for a formula that failed. */
const ERROR_VALUES: ReadonlySet<string> = new Set([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
]);

/** A text that is really a number written out ("R$ 1.234,56", "12%", "1234.5"): the cell should hold a number. */
function numberAsText(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  const money = ["R$", "US$", "$", "€"].find((p) => t.startsWith(p));
  const percent = t.endsWith("%");
  let body = money === undefined ? t : t.slice(money.length);
  if (percent) body = body.slice(0, -1);
  body = body.trim();
  if (body === "") return false;
  const digits = (s: string): boolean => [...s].every((ch) => ch >= "0" && ch <= "9");
  const plain = body.startsWith("-") ? body.slice(1) : body;
  if (plain === "") return false;
  // A currency or percent sign makes it a number even when whole; a bare text needs a decimal mark.
  if (money !== undefined || percent) {
    return [...plain].every((ch) => (ch >= "0" && ch <= "9") || ch === "." || ch === ",");
  }
  const marks = [...plain].filter((ch) => ch === "." || ch === ",").length;
  return (
    marks > 0 &&
    [...plain].every((ch) => digits(ch) || ch === "." || ch === ",") &&
    plain[0] !== "." &&
    plain[0] !== ","
  );
}

function xlsxReport(bytes: Uint8Array): DeliveryReport {
  let sheets: ReturnType<typeof inspectXlsx>["sheets"];
  try {
    sheets = inspectXlsx(bytes).sheets;
  } catch {
    return { problems: ["The Excel file does not open: it is not a valid .xlsx."], facts: [] };
  }
  if (sheets.length === 0) {
    return { problems: ["The Excel file has no sheets."], facts: [] };
  }
  const problems: string[] = [];
  const facts: string[] = [];
  const list = (cells: XlsxCell[]): string =>
    `${cells
      .slice(0, 5)
      .map((c) => c.ref)
      .join(", ")}${cells.length > 5 ? ` and ${cells.length - 5} more` : ""}`;
  for (const sheet of sheets) {
    const cells = sheet.cells;
    const formulas = cells.filter((c) => c.formula !== null);
    const broken = cells.filter(
      (c) =>
        (c.error && typeof c.value === "string" && ERROR_VALUES.has(c.value)) ||
        (c.formula !== null && [...ERROR_VALUES].some((e) => c.formula?.includes(e))),
    );
    if (broken.length > 0) {
      problems.push(
        `Sheet ${JSON.stringify(sheet.name)} has formulas with errors in ${list(broken)} (${[...new Set(broken.map((c) => c.value ?? "#REF!"))].join(", ")}). Fix the references and send again.`,
      );
    }
    const asText = cells.filter(
      (c) =>
        c.row > 1 && c.formula === null && typeof c.value === "string" && numberAsText(c.value),
    );
    if (asText.length > 0) {
      problems.push(
        `Sheet ${JSON.stringify(sheet.name)} has numbers stored as text in ${list(asText)} (for example ${JSON.stringify(asText[0]?.value)}). Write real numbers and give the cell a number format (currency, percent, decimals).`,
      );
    }
    const plainFormulas = formulas.filter((c) => c.format === "General");
    const plainDecimals = cells.filter(
      (c) =>
        c.formula === null &&
        c.format === "General" &&
        typeof c.value === "number" &&
        !Number.isInteger(c.value),
    );
    const unformatted = [...plainFormulas, ...plainDecimals];
    if (unformatted.length > 0) {
      problems.push(
        `Sheet ${JSON.stringify(sheet.name)} has numbers without a number format in ${list(unformatted)}. Set a real format (e.g. '"R$" #,##0.00', '0.00%', '#,##0.00') instead of leaving General.`,
      );
    }
    const rows = cells.reduce((n, c) => Math.max(n, c.row), 0);
    const cols = cells.reduce((n, c) => Math.max(n, c.col), 0);
    const formats = [...new Set(cells.map((c) => c.format).filter((f) => f !== "General"))];
    facts.push(
      `sheet ${JSON.stringify(sheet.name)}: ${rows} rows x ${cols} columns, ${formulas.length} formula(s)${formats.length === 0 ? "" : `, number formats: ${formats.join(" | ")}`}`,
    );
  }
  facts.unshift(`Excel, ${sheets.length} sheet(s)`);
  return { problems, facts };
}
