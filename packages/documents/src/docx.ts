// Builds the Word file with the `docx` library. The font is Geist, embedded in the file (the four
// faces), so it never depends on what the reader has installed. A4, margins per style, page numbers.
import type { DocumentStyle } from "@suup/core";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { FONT_FAMILY, fontBytes, MONO_FAMILY } from "./fonts.js";
import { imageInfo } from "./image-size.js";
import type { Block, Inline } from "./model.js";
import { plain } from "./model.js";
import { A4_TWIPS, CAPTION_SIZE, LONG_QUOTE, LOOKS, type Look } from "./style.js";

// The library's option types do not accept an explicit `undefined`; these take plain objects.
const para = (o: object): Paragraph => new Paragraph(o as never);
const txt = (o: object): TextRun => new TextRun(o as never);
const tcell = (o: object): TableCell => new TableCell(o as never);
const TWIPS_PER_CM = 567;
const cmToTwips = (cm: number): number => Math.round(cm * TWIPS_PER_CM);

export interface DocxInput {
  blocks: Block[];
  title: string;
  author: string;
  style: DocumentStyle;
  titleBlock: boolean;
  images: ReadonlyMap<string, Uint8Array>;
}

export interface DocxOutput {
  bytes: Uint8Array;
  expected: string[];
  tables: number;
  figures: number;
  problems: string[];
}

type Child = Paragraph | Table;

export async function buildDocx(input: DocxInput): Promise<DocxOutput> {
  const look = LOOKS[input.style];
  const academic = input.style === "academico";
  const problems: string[] = [];
  const expected: string[] = [];
  let tables = 0;
  let figureNumber = 0;
  let listInstances = 0;
  const margins = {
    top: cmToTwips(look.margin.top),
    right: cmToTwips(look.margin.right),
    bottom: cmToTwips(look.margin.bottom),
    left: cmToTwips(look.margin.left),
  };
  const contentTwips = A4_TWIPS.width - margins.left - margins.right;
  const pt = (points: number): number => Math.round(points * 2); // half-points
  const color = (hex: string): string => hex.slice(1);
  const line = (multiple: number): number => Math.round(multiple * 240);

  const runs = (
    inlines: readonly Inline[],
    extra: { color?: string; size?: number; bold?: boolean } = {},
  ): (TextRun | ExternalHyperlink)[] =>
    inlines.map((i) => {
      expected.push(i.text);
      const run = txt({
        text: i.text,
        bold: i.bold === true || extra.bold === true ? true : undefined,
        italics: i.italic === true ? true : undefined,
        font: i.code === true ? MONO_FAMILY : undefined,
        size:
          extra.size !== undefined
            ? pt(extra.size)
            : i.code === true
              ? pt(look.fontSize - 1)
              : undefined,
        color: i.link === undefined ? extra.color : academic ? "000000" : "1D4ED8",
        underline: i.link === undefined ? undefined : {},
      });
      return i.link === undefined ? run : new ExternalHyperlink({ link: i.link, children: [run] });
    });

  const convert = (blocks: readonly Block[], depth: number, level: number): Child[] => {
    const out: Child[] = [];
    for (const block of blocks) {
      switch (block.kind) {
        case "heading": {
          const headings = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
            HeadingLevel.HEADING_5,
            HeadingLevel.HEADING_6,
          ];
          out.push(
            para({
              heading: headings[block.depth - 1],
              children: runs(block.inlines),
            }),
          );
          break;
        }
        case "paragraph":
          out.push(
            para({
              children: runs(block.inlines),
              spacing: { after: Math.round(look.paragraphGap * 20), line: line(look.lineHeight) },
              alignment: look.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
              ...(look.indentCm > 0 && depth === 0
                ? { indent: { firstLine: cmToTwips(look.indentCm) } }
                : {}),
            }),
          );
          break;
        case "list": {
          const reference = block.ordered ? "numbers" : "bullets";
          const instance = block.ordered ? ++listInstances : 0;
          for (const item of block.items) {
            let first = true;
            for (const inner of item) {
              if (inner.kind === "paragraph") {
                out.push(
                  para({
                    children: runs(inner.inlines),
                    numbering: first
                      ? { reference, level: Math.min(level, 2), instance }
                      : undefined,
                    indent: first ? undefined : { left: 720 + 360 * level },
                    spacing: { after: 60, line: line(look.lineHeight) },
                    alignment: AlignmentType.LEFT,
                  }),
                );
              } else if (inner.kind === "list") {
                out.push(...convert([inner], depth + 1, level + 1));
              } else {
                out.push(...convert([inner], depth + 1, level + 1));
              }
              first = false;
            }
          }
          break;
        }
        case "table": {
          tables += 1;
          out.push(convertTable(block));
          out.push(para({ spacing: { after: 120 } }));
          break;
        }
        case "quote": {
          const quoteText = plain(
            block.blocks.flatMap((b) => (b.kind === "paragraph" ? b.inlines : [])),
          );
          const longQuote = academic && quoteText.length > 240;
          for (const inner of block.blocks) {
            if (inner.kind !== "paragraph") {
              out.push(...convert([inner], depth + 1, level));
              continue;
            }
            out.push(
              para({
                children: runs(inner.inlines, longQuote ? { size: LONG_QUOTE.fontSize } : {}),
                ...(academic
                  ? {
                      indent: longQuote ? { left: cmToTwips(LONG_QUOTE.indentCm) } : undefined,
                      spacing: {
                        after: 240,
                        line: line(longQuote ? LONG_QUOTE.lineHeight : look.lineHeight),
                      },
                      alignment: AlignmentType.JUSTIFIED,
                    }
                  : {
                      indent: { left: 360 },
                      border: {
                        left: {
                          style: BorderStyle.SINGLE,
                          size: 18,
                          color: color(look.accent),
                          space: 8,
                        },
                      },
                      spacing: { after: 120 },
                      run: { italics: true, color: "444444" },
                    }),
              }),
            );
          }
          break;
        }
        case "code":
          expected.push(...block.text.split("\n"));
          block.text.split("\n").forEach((codeLine, i, all) => {
            out.push(
              para({
                children: [
                  txt({ text: codeLine, font: MONO_FAMILY, size: pt(look.fontSize - 1.5) }),
                ],
                shading: { type: ShadingType.CLEAR, fill: "F5F5F5", color: "auto" },
                spacing: { after: i === all.length - 1 ? 160 : 0, line: 260 },
              }),
            );
          });
          break;
        case "rule":
          out.push(
            para({
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BDBDBD", space: 1 } },
              spacing: { before: 120, after: 200 },
            }),
          );
          break;
        case "pagebreak":
          out.push(para({ children: [new PageBreak()] }));
          break;
        case "figure": {
          const bytes = input.images.get(block.path);
          const info = bytes === undefined ? undefined : imageInfo(bytes);
          if (bytes === undefined || info === undefined) {
            problems.push(
              `The image ${JSON.stringify(block.path)} is not a PNG or JPEG file (only those two are accepted).`,
            );
            break;
          }
          if (academic && (block.source ?? "").trim() === "") {
            problems.push(
              `The image ${JSON.stringify(block.path)} has no source: in the academico style every figure needs one, as the image title ![description](path "where it came from").`,
            );
          }
          figureNumber += 1;
          const maxWidthPx = contentTwips / 15;
          const maxHeightPx = 400;
          const scale = Math.min(1, maxWidthPx / info.width, maxHeightPx / info.height);
          // ABNT: "Figura 1 – title" (an en dash, as the norm writes it), the source on its own line.
          const caption = `Figura ${figureNumber} \u2013 ${stripEnd(block.alt)}`;
          const sourceLine = block.source === undefined ? "" : `Fonte: ${stripEnd(block.source)}.`;
          expected.push(caption);
          if (sourceLine !== "") expected.push(sourceLine);
          out.push(
            para({
              alignment: AlignmentType.CENTER,
              keepNext: true,
              spacing: { before: 120, after: 80 },
              children: [
                new ImageRun({
                  type: info.type,
                  data: bytes,
                  transformation: {
                    width: Math.max(1, Math.round(info.width * scale)),
                    height: Math.max(1, Math.round(info.height * scale)),
                  },
                  altText: { name: block.alt, title: block.alt, description: block.alt },
                }),
              ],
            }),
            para({
              alignment: AlignmentType.CENTER,
              spacing: { after: sourceLine === "" ? 240 : 0, line: 240 },
              children: [txt({ text: caption, size: pt(CAPTION_SIZE) })],
            }),
            ...(sourceLine === ""
              ? []
              : [
                  para({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 240, line: 240 },
                    children: [txt({ text: sourceLine, size: pt(CAPTION_SIZE) })],
                  }),
                ]),
          );
          break;
        }
      }
    }
    return out;
  };

  const convertTable = (block: Extract<Block, { kind: "table" }>): Table => {
    const columns = Math.max(block.head.length, ...block.rows.map((r) => r.length), 1);
    const weights = Array.from({ length: columns }, (_, c) =>
      Math.min(
        Math.max(
          Math.max(
            plain(block.head[c] ?? []).length,
            ...block.rows.map((r) => plain(r[c] ?? []).length),
          ),
          8,
        ),
        40,
      ),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.floor((contentTwips * w) / total));
    const size = academic ? 10 : look.fontSize - 1;
    const align = (c: number): (typeof AlignmentType)[keyof typeof AlignmentType] =>
      block.align[c] === "right"
        ? AlignmentType.RIGHT
        : block.align[c] === "center"
          ? AlignmentType.CENTER
          : AlignmentType.LEFT;
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const hair = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
    const rule = { style: BorderStyle.SINGLE, size: 6, color: "000000" };
    const row = (cells: Inline[][], head: boolean, index: number, last: boolean): TableRow =>
      new TableRow({
        tableHeader: head,
        cantSplit: true,
        children: Array.from({ length: columns }, (_, c) => {
          return tcell({
            width: { size: widths[c] ?? 1000, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 110, right: 110 },
            shading: academic
              ? undefined
              : head
                ? { type: ShadingType.CLEAR, fill: color(look.accent), color: "auto" }
                : index % 2 === 0
                  ? { type: ShadingType.CLEAR, fill: "F6F7F9", color: "auto" }
                  : undefined,
            borders: academic
              ? {
                  top: head ? rule : none,
                  bottom: head || last ? rule : none,
                  left: none,
                  right: none,
                }
              : { top: none, left: none, right: none, bottom: head || last ? none : hair },
            children: [
              para({
                alignment: align(c),
                spacing: { line: academic ? 240 : 290 },
                children: runs(cells[c] ?? [], {
                  size,
                  bold: head,
                  ...(head && !academic ? { color: "FFFFFF" } : {}),
                }),
              }),
            ],
          });
        }),
      });
    return new Table({
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths: widths,
      rows: [
        row(block.head, true, 0, false),
        ...block.rows.map((r, i) => row(r, false, i + 1, i === block.rows.length - 1)),
      ],
    });
  };

  const children: Child[] = [];
  if (input.titleBlock) {
    expected.push(input.title);
    children.push(
      para({
        heading: HeadingLevel.TITLE,
        alignment: academic ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [txt({ text: input.title, allCaps: academic })],
      }),
    );
  }
  children.push(...convert(input.blocks, 0, 0));
  if (children.length === 0) children.push(para({}));

  const f = fontBytes();
  const page = {
    size: { width: A4_TWIPS.width, height: A4_TWIPS.height },
    margin: { ...margins, header: academic ? cmToTwips(2) : 708, footer: 708 },
  };
  const numberPara = (
    align: (typeof AlignmentType)[keyof typeof AlignmentType],
    withTotal: boolean,
  ): Paragraph =>
    para({
      alignment: align,
      children: withTotal
        ? [
            txt({
              children: ["Página ", PageNumber.CURRENT, " de ", PageNumber.TOTAL_PAGES],
              size: 17,
              color: "777777",
            }),
          ]
        : [txt({ children: [PageNumber.CURRENT], size: 20 })],
    });
  const doc = new Document({
    title: input.title,
    creator: input.author,
    lastModifiedBy: input.author,
    description: "",
    fonts: [
      {
        name: FONT_FAMILY,
        data: Buffer.from(f.regular),
        bold: Buffer.from(f.bold),
        italic: Buffer.from(f.italic),
        boldItalic: Buffer.from(f.boldItalic),
      },
      { name: MONO_FAMILY, data: Buffer.from(f.mono) },
    ],
    styles: {
      default: {
        document: {
          run: { font: FONT_FAMILY, size: pt(look.fontSize), color: color(look.color) },
          paragraph: {
            spacing: { line: line(look.lineHeight), after: Math.round(look.paragraphGap * 20) },
          },
        },
        ...headingStyles(look),
        title: {
          run: {
            font: FONT_FAMILY,
            size: pt(look.headingSizes[0] ?? 22),
            bold: true,
            color: color(look.accent),
          },
          paragraph: { spacing: { after: academic ? 360 : 280 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: level === 1 ? "–" : "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 + 360 * level, hanging: 360 } } },
          })),
        },
        {
          reference: "numbers",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: level === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 + 360 * level, hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page, ...(academic ? { titlePage: true } : {}) },
        headers: academic
          ? {
              default: new Header({ children: [numberPara(AlignmentType.RIGHT, false)] }),
              first: new Header({ children: [para({})] }),
            }
          : undefined,
        footers: academic
          ? undefined
          : { default: new Footer({ children: [numberPara(AlignmentType.RIGHT, true)] }) },
        children,
      },
    ],
  } as never);
  const buffer = await Packer.toBuffer(doc);
  return { bytes: new Uint8Array(buffer), expected, tables, figures: figureNumber, problems };
}

function headingStyles(look: Look): Record<string, unknown> {
  const academic = look.pageNumber === "top-right";
  const out: Record<string, unknown> = {};
  look.headingSizes.forEach((size, i) => {
    out[`heading${i + 1}`] = {
      run: {
        font: FONT_FAMILY,
        size: Math.round(size * 2),
        bold: academic ? i <= 1 : true,
        italics: academic && i === 3,
        allCaps: look.headingUpper && i === 0,
        color: look.accent.slice(1),
      },
      paragraph: {
        keepNext: true,
        spacing: academic
          ? { before: i === 0 ? 240 : 120, after: 240, line: Math.round(look.lineHeight * 240) }
          : { before: i === 0 ? 80 : 240, after: i === 0 ? 200 : 120 },
      },
    };
  });
  return out;
}

function stripEnd(text: string): string {
  let t = text.trim();
  while (t.endsWith(".")) t = t.slice(0, -1).trimEnd();
  return t;
}
