// Reads a finished PDF or xlsx the way a person would open it and reports what it finds, for
// anyone to judge (the evaluation of `create_document` against a script the bot writes itself).
// It checks nothing on its own and knows nothing about who made the file: the same code opens a
// file made by `create_document` and one made by a script. The PDF reading is the one `checkPdf`
// uses (pdf.js, as a reader would); the xlsx reading is the ZIP of XML `checkXlsx` reads.
import { strFromU8, unzipSync } from "fflate";
import { A4_PT } from "./style.js";
import { type PdfJs, pdfjs, squash } from "./verify-pdf.js";
import { tagAttributes, tagTexts } from "./xml.js";

export interface PdfLine {
  page: number;
  /** The baseline, in points from the bottom of the page. */
  y: number;
  /** Left and right edge of the text in points from the left of the page. */
  left: number;
  right: number;
  /** The biggest font size on the line. */
  size: number;
  text: string;
  /** The items of the line, left to right. */
  items: string[];
}

export interface PdfInspection {
  pages: number;
  /** Every page measures A4 (within a point). */
  allA4: boolean;
  title: string | null;
  author: string | null;
  fonts: string[];
  /** Fonts the PDF uses without carrying them. */
  missingFonts: string[];
  /** The extracted text had the replacement character. */
  brokenText: boolean;
  /** The text of the whole file, line by line (page order). */
  lines: PdfLine[];
  /** The text without spaces and line breaks (the same flattening `checkPdf` uses). */
  flat: string;
  /** Images drawn on the pages. */
  images: number;
  /** Page size in points (the first page). */
  pageSize: { width: number; height: number };
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const lib: PdfJs = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const info = (await doc.getMetadata()).info;
    const lines: PdfLine[] = [];
    const used = new Set<string>();
    const missing = new Set<string>();
    const names = new Set<string>();
    let allA4 = true;
    let images = 0;
    let pageSize = { width: A4_PT.width, height: A4_PT.height };
    const imageOps = [lib.OPS?.paintImageXObject, lib.OPS?.paintInlineImageXObject].filter(
      (op): op is number => op !== undefined,
    );
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
      const width = x1 - x0;
      const height = y1 - y0;
      if (n === 1) pageSize = { width, height };
      if (Math.abs(width - A4_PT.width) > 1 || Math.abs(height - A4_PT.height) > 1) allA4 = false;
      const content = await page.getTextContent();
      const ops = await page.getOperatorList();
      images += ops.fnArray.filter((fn) => imageOps.includes(fn)).length;
      const byY = new Map<number, PdfLine>();
      const placed = new Map<number, { x: number; text: string }[]>();
      for (const item of content.items) {
        if (item.fontName !== undefined) used.add(item.fontName);
        const text = item.str ?? "";
        const t = item.transform;
        if (text === "" || t === undefined) continue;
        const size = Math.hypot(t[2] ?? 0, t[3] ?? 0);
        const x = t[4] ?? 0;
        const y = Math.round((t[5] ?? 0) * 2) / 2;
        const line = byY.get(y) ?? {
          page: n,
          y,
          left: x,
          right: x,
          size,
          text: "",
          items: [],
        };
        line.left = Math.min(line.left, x);
        line.right = Math.max(line.right, x + (item.width ?? 0));
        line.size = Math.max(line.size, size);
        byY.set(y, line);
        placed.set(y, [...(placed.get(y) ?? []), { x, text }]);
      }
      for (const [y, line] of byY) {
        // Left to right, as the line reads: the order of the content stream is the maker's choice.
        line.items = (placed.get(y) ?? []).sort((a, b) => a.x - b.x).map((p) => p.text);
        line.text = line.items.join("");
      }
      lines.push(...[...byY.values()].sort((a, b) => b.y - a.y));
      for (const id of used) {
        const font = page.commonObjs.get(id);
        if (font === undefined || font.missingFile === true) missing.add(id);
        else names.add(id);
      }
    }
    const all = lines.map((l) => l.items.join(" ")).join(" ");
    const title = info.Title;
    const author = info.Author;
    return {
      pages: doc.numPages,
      allA4,
      title: typeof title === "string" ? title : null,
      author: typeof author === "string" ? author : null,
      fonts: [...names],
      missingFonts: [...missing],
      brokenText: all.includes("�"),
      lines,
      flat: squash(all),
      images,
      pageSize,
    };
  } finally {
    await task.destroy();
  }
}

// --- xlsx -----------------------------------------------------------------------------------

export interface XlsxCell {
  ref: string;
  /** 1-based. */
  row: number;
  /** 1-based (A is 1). */
  col: number;
  value: string | number | boolean | null;
  /** The formula without the `=`. */
  formula: string | null;
  /** The number format code in force ("General" when none). */
  format: string;
}

export interface XlsxInspection {
  sheets: { name: string; cells: XlsxCell[] }[];
}

/** The built-in number formats that need no entry in the styles part. */
const BUILT_IN_FORMATS: Readonly<Record<string, string>> = {
  "0": "General",
  "1": "0",
  "2": "0.00",
  "3": "#,##0",
  "4": "#,##0.00",
  "9": "0%",
  "10": "0.00%",
};

/** `&#231;` and `&#xE7;` to the character (other writers escape what Suup's own does not). */
function characterReferences(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("&#", at);
    const close = open === -1 ? -1 : text.indexOf(";", open);
    if (open === -1 || close === -1 || close - open > 10) return out + text.slice(at);
    const hex = text[open + 2] === "x" || text[open + 2] === "X";
    const code = Number.parseInt(text.slice(open + (hex ? 3 : 2), close), hex ? 16 : 10);
    out += text.slice(at, open) + (Number.isNaN(code) ? "" : String.fromCodePoint(code));
    at = close + 1;
  }
}

function splitRef(ref: string): { row: number; col: number } {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    col = col * 26 + (code - 64);
  }
  return { row: Number(ref.slice(i)), col };
}

/** The `<c ...>...</c>` elements of a sheet, each as its opening attributes and inner XML. */
function cellElements(xml: string): { attrs: Record<string, string>; inner: string }[] {
  const out: { attrs: Record<string, string>; inner: string }[] = [];
  let from = 0;
  for (;;) {
    const at = xml.indexOf("<c ", from);
    if (at === -1) return out;
    const end = xml.indexOf(">", at);
    if (end === -1) return out;
    const attrs = tagAttributes(xml.slice(at, end + 1), "c")[0] ?? {};
    if (xml[end - 1] === "/") {
      out.push({ attrs, inner: "" });
      from = end + 1;
      continue;
    }
    const close = xml.indexOf("</c>", end);
    if (close === -1) return out;
    out.push({ attrs, inner: xml.slice(end + 1, close) });
    from = close + 4;
  }
}

export function inspectXlsx(bytes: Uint8Array): XlsxInspection {
  const files = unzipSync(bytes);
  const text = (name: string): string => {
    const file = files[name];
    return file === undefined ? "" : strFromU8(file);
  };
  const workbook = text("xl/workbook.xml");
  const names = tagAttributes(workbook, "sheet").map((a) => a.name ?? "");
  // The sheet files in workbook order (each `<sheet>` points to a part by relationship id).
  const rels = tagAttributes(text("xl/_rels/workbook.xml.rels"), "Relationship");
  const targets = tagAttributes(workbook, "sheet").map((a) => {
    const rel = rels.find((r) => r.Id === a["r:id"]);
    const target = rel?.Target ?? "";
    return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  });
  const shared: string[] = [];
  const sst = text("xl/sharedStrings.xml");
  let from = 0;
  for (;;) {
    const at = sst.indexOf("<si>", from);
    if (at === -1) break;
    const close = sst.indexOf("</si>", at);
    if (close === -1) break;
    shared.push(characterReferences(tagTexts(sst.slice(at, close), "t").join("")));
    from = close + 5;
  }
  const styles = text("xl/styles.xml");
  const custom = new Map(
    tagAttributes(styles, "numFmt").map((a) => [
      a.numFmtId ?? "",
      characterReferences(a.formatCode ?? ""),
    ]),
  );
  const xfStart = styles.indexOf("<cellXfs");
  const xfEnd = styles.indexOf("</cellXfs>");
  const xfs =
    xfStart === -1 || xfEnd === -1 ? [] : tagAttributes(styles.slice(xfStart, xfEnd), "xf");
  const formatOf = (style: string | undefined): string => {
    const xf = xfs[Number(style ?? "0")];
    const id = xf?.numFmtId ?? "0";
    return custom.get(id) ?? BUILT_IN_FORMATS[id] ?? `built-in ${id}`;
  };
  return {
    sheets: names.map((name, i) => {
      const xml = text(targets[i] ?? `xl/worksheets/sheet${i + 1}.xml`);
      const cells: XlsxCell[] = [];
      for (const { attrs, inner } of cellElements(xml)) {
        const ref = attrs.r ?? "";
        const { row, col } = splitRef(ref);
        const type = attrs.t;
        const raw = tagTexts(inner, "v")[0];
        const formula = tagTexts(inner, "f")[0] ?? null;
        let value: XlsxCell["value"] = null;
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? null;
        else if (type === "inlineStr") value = characterReferences(tagTexts(inner, "t").join(""));
        else if (type === "str") value = raw === undefined ? null : characterReferences(raw);
        else if (type === "b") value = raw === "1";
        else if (raw !== undefined && raw !== "") value = Number(raw);
        cells.push({ ref, row, col, value, formula, format: formatOf(attrs.s) });
      }
      return { name, cells };
    }),
  };
}
