// Builds the PDF with pdfmake (pure JavaScript, in this process). The text of the bot only ever
// enters as strings, never as a definition object; nothing is fetched from the network or the disk
// (the access policies refuse everything and the font and images are handed over as bytes).
import type { DocumentStyle } from "@suup/core";
import pdfmakeEngine from "pdfmake";
import type { Content, TDocumentDefinitions, TFontDictionary } from "pdfmake/interfaces.js";
import { FONT_FAMILY, fontBytes, MONO_FAMILY } from "./fonts.js";
import { type ImageInfo, imageInfo } from "./image-size.js";
import type { Block, Inline } from "./model.js";
import { plain } from "./model.js";
import { A4_PT, CAPTION_SIZE, CM, LONG_QUOTE, LOOKS, type Look } from "./style.js";

interface PdfMake {
  addFonts(fonts: TFontDictionary): void;
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
  createPdf(definition: TDocumentDefinitions): { getBuffer(): Promise<Uint8Array> };
}

let pdfmake: PdfMake | undefined;
function engine(): PdfMake {
  if (pdfmake === undefined) {
    pdfmake = pdfmakeEngine as unknown as PdfMake;
    const f = fontBytes();
    pdfmake.addFonts({
      [FONT_FAMILY]: {
        normal: f.regular,
        bold: f.bold,
        italics: f.italic,
        bolditalics: f.boldItalic,
      },
      [MONO_FAMILY]: { normal: f.mono, bold: f.mono, italics: f.mono, bolditalics: f.mono },
    } as unknown as TFontDictionary);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => false);
  }
  return pdfmake;
}

export interface PdfInput {
  blocks: Block[];
  title: string;
  author: string;
  style: DocumentStyle;
  /** Add the title as a heading block at the top (the content does not open with its own h1). */
  titleBlock: boolean;
  images: ReadonlyMap<string, Uint8Array>;
}

export interface PdfOutput {
  bytes: Uint8Array;
  /** The strings drawn on the pages, for the check that text extraction finds them. */
  expected: string[];
  problems: string[];
}

export async function buildPdf(input: PdfInput): Promise<PdfOutput> {
  const look = LOOKS[input.style];
  const problems: string[] = [];
  const expected: string[] = [];
  const images: Record<string, Uint8Array> = {};
  const contentWidth = A4_PT.width - (look.margin.left + look.margin.right) * CM;
  let figureNumber = 0;

  const text = (inlines: readonly Inline[], extra: Record<string, unknown> = {}): Content[] =>
    inlines.map((i) => {
      expected.push(i.text);
      return {
        text: i.text,
        ...(i.bold === true ? { bold: true } : {}),
        ...(i.italic === true ? { italics: true } : {}),
        ...(i.code === true ? { font: MONO_FAMILY, fontSize: look.fontSize - 1 } : {}),
        ...(i.link === undefined
          ? {}
          : {
              link: i.link,
              color: look.accent === "#000000" ? "#000000" : "#1d4ed8",
              decoration: "underline" as const,
            }),
        ...extra,
      } as Content;
    });

  const paragraph = (inlines: readonly Inline[], extra: Record<string, unknown> = {}): Content => ({
    text: text(inlines),
    style: "body",
    ...extra,
  });

  const convert = (blocks: readonly Block[], depth: number): Content[] => {
    const out: Content[] = [];
    for (const block of blocks) {
      switch (block.kind) {
        case "heading": {
          const level = block.depth;
          const upper = look.headingUpper && level === 1;
          const inlines = upper
            ? block.inlines.map((i) => ({ ...i, text: i.text.toUpperCase() }))
            : block.inlines;
          out.push({
            text: text(inlines),
            style: `h${level}`,
            headlineLevel: level,
            ...(input.style === "academico" ? { bold: level <= 2, italics: level === 4 } : {}),
          } as Content);
          break;
        }
        case "paragraph":
          out.push(
            paragraph(
              block.inlines,
              look.indentCm > 0 && depth === 0 ? { leadingIndent: look.indentCm * CM } : {},
            ),
          );
          break;
        case "list": {
          const items = block.items.map((item): Content => {
            const inner = convert(item, depth + 1);
            return inner.length === 1 ? (inner[0] as Content) : { stack: inner };
          });
          out.push(
            block.ordered
              ? ({ ol: items, start: block.start, style: "list" } as Content)
              : ({ ul: items, style: "list" } as Content),
          );
          break;
        }
        case "table":
          out.push(convertTable(block, look, contentWidth, text));
          break;
        case "quote": {
          const quoteText = plain(
            block.blocks.flatMap((b) => (b.kind === "paragraph" ? b.inlines : [])),
          );
          const inner = convert(block.blocks, depth + 1);
          if (input.style === "academico") {
            // ABNT: a long quotation is set apart (4 cm in, smaller, single spaced); a short one
            // stays in the text. "Long" is more than three lines: about 240 characters here.
            out.push(
              quoteText.length > 240
                ? {
                    stack: inner,
                    margin: [LONG_QUOTE.indentCm * CM, 0, 0, 12],
                    fontSize: LONG_QUOTE.fontSize,
                    lineHeight: LONG_QUOTE.lineHeight,
                  }
                : { stack: inner },
            );
          } else {
            out.push({
              table: { widths: ["*"], body: [[{ stack: inner, margin: [8, 2, 4, 2] }]] },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
                vLineColor: () => look.accent,
                paddingLeft: () => 0,
                paddingRight: () => 0,
                paddingTop: () => 0,
                paddingBottom: () => 0,
              },
              italics: true,
              color: "#444444",
              margin: [8, 0, 0, 8],
            } as Content);
          }
          break;
        }
        case "code": {
          expected.push(...block.text.split("\n"));
          out.push({
            table: {
              widths: ["*"],
              body: [
                [
                  {
                    text: block.text,
                    font: MONO_FAMILY,
                    fontSize: look.fontSize - 1.5,
                    lineHeight: 1.25,
                    preserveLeadingSpaces: true,
                  },
                ],
              ],
            },
            layout: {
              hLineWidth: () => 0.5,
              vLineWidth: () => 0.5,
              hLineColor: () => "#d4d4d4",
              vLineColor: () => "#d4d4d4",
              fillColor: () => "#f5f5f5",
              paddingLeft: () => 8,
              paddingRight: () => 8,
              paddingTop: () => 6,
              paddingBottom: () => 6,
            },
            margin: [0, 2, 0, 10],
          } as Content);
          break;
        }
        case "rule":
          out.push({
            canvas: [
              {
                type: "line",
                x1: 0,
                y1: 0,
                x2: contentWidth,
                y2: 0,
                lineWidth: 0.75,
                lineColor: "#bdbdbd",
              },
            ],
            margin: [0, 6, 0, 10],
          } as Content);
          break;
        case "pagebreak":
          out.push({ text: "", pageBreak: "after" } as Content);
          break;
        case "figure": {
          const bytes = input.images.get(block.path);
          const info: ImageInfo | undefined = bytes === undefined ? undefined : imageInfo(bytes);
          if (bytes === undefined || info === undefined) {
            problems.push(
              `The image ${JSON.stringify(block.path)} is not a PNG or JPEG file (only those two are accepted).`,
            );
            break;
          }
          if (input.style === "academico" && (block.source ?? "").trim() === "") {
            problems.push(
              `The image ${JSON.stringify(block.path)} has no source: in the academico style every figure needs one, as the image title ![description](path "where it came from").`,
            );
          }
          figureNumber += 1;
          const key = `img${Object.keys(images).length}`;
          images[key] = bytes;
          const caption = `Figura ${figureNumber}: ${stripEnd(block.alt)}.${
            block.source === undefined ? "" : ` Fonte: ${stripEnd(block.source)}.`
          }`;
          expected.push(caption);
          out.push({
            stack: [
              { image: key, fit: [contentWidth, 300], alignment: "center", margin: [0, 6, 0, 4] },
              {
                text: caption,
                fontSize: CAPTION_SIZE,
                lineHeight: 1.2,
                alignment: "center",
                color: look.pageNumber === "footer" ? "#555555" : "#000000",
                margin: [0, 0, 0, 12],
              },
            ],
            unbreakable: true,
          } as Content);
          break;
        }
      }
    }
    return out;
  };

  const content: Content[] = [];
  if (input.titleBlock) {
    expected.push(input.title);
    content.push({
      text: input.style === "academico" ? input.title.toUpperCase() : input.title,
      style: "title",
    } as Content);
  }
  content.push(...convert(input.blocks, 0));
  // pdfmake's default font is not used; this one is the only family given.
  const m = look.margin;
  const definition: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [m.left * CM, m.top * CM, m.right * CM, m.bottom * CM],
    info: {
      title: input.title,
      author: input.author,
      creator: "Suup",
      producer: "Suup",
    },
    images: images as never,
    defaultStyle: {
      font: FONT_FAMILY,
      fontSize: look.fontSize,
      lineHeight: look.lineHeight,
      color: look.color,
      alignment: look.justify ? "justify" : "left",
    },
    styles: {
      body: { margin: [0, 0, 0, look.paragraphGap] },
      list: { margin: [0, 0, 0, look.paragraphGap], alignment: "left" },
      title: {
        fontSize: look.headingSizes[0] ?? 22,
        bold: true,
        alignment: input.style === "academico" ? "center" : "left",
        margin: [0, 0, 0, input.style === "academico" ? 18 : 14],
        color: look.accent,
      },
      ...Object.fromEntries(
        look.headingSizes.map((size, i) => [
          `h${i + 1}`,
          {
            fontSize: size,
            bold: true,
            alignment: "left",
            color: look.accent,
            lineHeight: input.style === "academico" ? look.lineHeight : 1.2,
            margin:
              input.style === "academico"
                ? [0, i === 0 ? 12 : 6, 0, 12]
                : [0, i === 0 ? 4 : 12, 0, i === 0 ? 10 : 6],
          },
        ]),
      ),
    },
    content,
    pageBreakBefore: (current, following) =>
      current.headlineLevel !== undefined && (following as unknown as unknown[]).length === 0,
    ...(look.pageNumber === "footer"
      ? {
          footer: (page: number, pages: number): Content => ({
            text: `Página ${page} de ${pages}`,
            alignment: "right",
            fontSize: 8.5,
            color: "#777777",
            margin: [m.left * CM, 18, m.right * CM, 0],
          }),
        }
      : {
          // ABNT: the pages count from the first, the number shows from the second, at the top
          // right, 2 cm from the top edge.
          header: (page: number): Content =>
            page === 1
              ? ""
              : {
                  text: String(page),
                  alignment: "right",
                  fontSize: 10,
                  margin: [m.left * CM, 2 * CM, m.right * CM, 0],
                },
        }),
  };
  const buffer = await engine().createPdf(definition).getBuffer();
  return { bytes: new Uint8Array(buffer), expected, problems };
}

function stripEnd(text: string): string {
  let t = text.trim();
  while (t.endsWith(".")) t = t.slice(0, -1).trimEnd();
  return t;
}

function convertTable(
  block: Extract<Block, { kind: "table" }>,
  look: Look,
  contentWidth: number,
  text: (inlines: readonly Inline[], extra?: Record<string, unknown>) => Content[],
): Content {
  const columns = Math.max(block.head.length, ...block.rows.map((r) => r.length), 1);
  const weights = Array.from({ length: columns }, (_, c) => {
    const longest = Math.max(
      plain(block.head[c] ?? []).length,
      ...block.rows.map((r) => plain(r[c] ?? []).length),
    );
    return Math.min(Math.max(longest, 8), 40);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (contentWidth * w) / total);
  const alignOf = (c: number): string => block.align[c] ?? "left";
  const size = look.pageNumber === "footer" ? look.fontSize - 1 : 10;
  const academic = look.pageNumber === "top-right";
  const cell = (inlines: Inline[], c: number, head: boolean): Content =>
    ({
      text: text(inlines, head && !academic ? { color: "#ffffff" } : {}),
      bold: head,
      alignment: alignOf(c),
      fontSize: size,
      lineHeight: academic ? 1 : 1.25,
      // The cells of a header or a table never justify.
    }) as Content;
  const pad = (cells: Inline[][]): Inline[][] =>
    Array.from({ length: columns }, (_, c) => cells[c] ?? []);
  const body = [
    pad(block.head).map((c, i) => cell(c, i, true)),
    ...block.rows.map((r) => pad(r).map((c, i) => cell(c, i, false))),
  ];
  const last = body.length;
  return {
    table: { headerRows: 1, widths, dontBreakRows: true, body },
    layout: academic
      ? {
          // ABNT tables are open at the sides: lines above and below the header and at the end.
          hLineWidth: (i: number) => (i === 0 || i === 1 || i === last ? 0.75 : 0),
          vLineWidth: () => 0,
          paddingTop: () => 3,
          paddingBottom: () => 3,
        }
      : {
          hLineWidth: (i: number) => (i === 0 || i === last ? 0 : 0.5),
          vLineWidth: () => 0,
          hLineColor: () => "#d9d9d9",
          fillColor: (row: number) => (row === 0 ? look.accent : row % 2 === 0 ? "#f6f7f9" : null),
          paddingLeft: () => 7,
          paddingRight: () => 7,
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
    margin: [0, 4, 0, 12],
  } as Content;
}
