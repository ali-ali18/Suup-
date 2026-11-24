// Opens the built PDF again (pdf.js, as a reader would) and checks it before it is delivered.
import { A4_PT } from "./style.js";

export interface PdfCheck {
  pages: number;
  checks: string[];
  problems: string[];
}

export interface PdfJs {
  OPS?: Record<string, number>;
  getDocument(src: Record<string, unknown>): {
    promise: Promise<PdfDoc>;
    destroy(): Promise<void>;
  };
}
export interface PdfDoc {
  numPages: number;
  getMetadata(): Promise<{ info: Record<string, unknown> }>;
  getPage(n: number): Promise<PdfPage>;
}
export interface PdfPage {
  view: number[];
  getTextContent(): Promise<{
    items: { str?: string; fontName?: string; transform?: number[]; width?: number }[];
  }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  commonObjs: { get(id: string): { missingFile?: boolean; name?: string } | undefined };
}

let loaded: Promise<PdfJs> | undefined;
export async function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    // The worker is imported here (not found by path), so a bundle of the server carries it.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  })();
  return loaded;
}

/** Spaces and line breaks do not count: justified text and pdf.js split the words differently. */
export function squash(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch.trim() !== "" && ch !== " ") out += ch;
  }
  return out;
}

export async function checkPdf(
  bytes: Uint8Array,
  expect: {
    title: string;
    author: string;
    maxPages: number | undefined;
    texts: string[];
    /** The page margins in points: the header and footer (page numbers) lie outside the body. */
    margins: { top: number; bottom: number };
  },
): Promise<PdfCheck> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const problems: string[] = [];
  const checks: string[] = [];
  const doc = await task.promise;
  try {
    const pages = doc.numPages;
    if (expect.maxPages !== undefined && pages > expect.maxPages) {
      problems.push(
        `The PDF has ${pages} pages but at most ${expect.maxPages} were asked for. Shorten the content (fewer or shorter sections) and call create_document again.`,
      );
    } else if (expect.maxPages !== undefined) {
      checks.push(`${pages} page${pages === 1 ? "" : "s"} (limit ${expect.maxPages})`);
    }
    const info = (await doc.getMetadata()).info;
    if (info.Title !== expect.title || info.Author !== expect.author) {
      problems.push("The PDF's title or author did not survive in its metadata.");
    } else {
      checks.push("title and author in the metadata");
    }
    let all = "";
    const missing = new Set<string>();
    const fontsUsed = new Set<string>();
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      if (
        Math.abs((x1 ?? 0) - (x0 ?? 0) - A4_PT.width) > 1 ||
        Math.abs((y1 ?? 0) - (y0 ?? 0) - A4_PT.height) > 1
      ) {
        problems.push(`Page ${n} is not A4.`);
      }
      const content = await page.getTextContent();
      await page.getOperatorList();
      const height = (y1 ?? 0) - (y0 ?? 0);
      for (const item of content.items) {
        if (item.fontName !== undefined) fontsUsed.add(item.fontName);
        const y = item.transform?.[5];
        // The page number sits in the margin and, when a paragraph runs over the page, would split it.
        if (y !== undefined && (y > height - expect.margins.top || y < expect.margins.bottom))
          continue;
        all += `${item.str ?? ""} `;
      }
      for (const id of fontsUsed) {
        const font = page.commonObjs.get(id);
        if (font === undefined || font.missingFile === true) missing.add(id);
      }
    }
    checks.push("A4");
    if (fontsUsed.size === 0 && expect.texts.some((t) => squash(t) !== "")) {
      problems.push("The PDF has no readable text.");
    } else if (missing.size > 0) {
      problems.push(`Fonts not embedded in the PDF: ${[...missing].join(", ")}.`);
    } else {
      checks.push(`${fontsUsed.size} font${fontsUsed.size === 1 ? "" : "s"}, all embedded`);
    }
    const flat = squash(all);
    if (flat.includes("�")) problems.push("The extracted text has broken characters.");
    const lost = expect.texts.filter((t) => squash(t) !== "" && !flat.includes(squash(t)));
    if (lost.length > 0) {
      problems.push(
        `Text that did not come out of the PDF (characters the font cannot draw?): ${lost
          .slice(0, 3)
          .map((t) => JSON.stringify(t.slice(0, 50)))
          .join(", ")}.`,
      );
    } else {
      checks.push("text extracted with accents intact");
    }
    return { pages, checks, problems };
  } finally {
    await task.destroy();
  }
}
