// Owns what a document the bot asks for IS (docs/pesquisas/ferramenta-de-documento.md): the bot
// gives the content and the format, and whoever the runtime binds (`@suup/documents`) builds a
// well-designed file in the server process. No Python, no terminal. The file then goes to the
// user's chat by the same seam as `send_file` (`FileSender`), so it is the same card.
import { z } from "zod";

/** The tool's name. The prompt mentions it, and the runtime offers it next to `send_file`. */
export const CREATE_DOCUMENT_TOOL_NAME = "create_document";

/** The formats Suup builds. */
export const DOCUMENT_FORMATS = ["pdf", "docx", "xlsx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** The MIME type of each format (what the file card and the download say). */
export const DOCUMENT_MIME: Readonly<Record<DocumentFormat, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The longest Markdown text a PDF or Word document is built from (about 150 pages of prose). */
export const MAX_DOCUMENT_CHARS = 400_000;
/** At most this many sheets, rows per sheet, cells per row and cells in all. */
export const MAX_SHEETS = 50;
export const MAX_SHEET_ROWS = 50_000;
export const MAX_SHEET_COLUMNS = 200;
export const MAX_SHEET_CELLS = 500_000;
/** Excel's own limits: 31 characters in a sheet name, 32 767 in a cell. */
export const MAX_SHEET_NAME_LENGTH = 31;
export const MAX_CELL_CHARS = 32_767;

/** How a number cell is shown in Excel. `currency` is Brazilian real: `"R$" #,##0.00`. */
export const CELL_FORMATS = ["integer", "decimal", "currency", "percent"] as const;
export type CellFormat = (typeof CELL_FORMATS)[number];

/** The Excel number format of each `CellFormat`. */
export const CELL_FORMAT_CODES: Readonly<Record<CellFormat, string>> = {
  integer: "#,##0",
  decimal: "#,##0.00",
  currency: '"R$" #,##0.00',
  percent: "0.00%",
};

// The schema the model is shown is kept short (every request carries it); the limits that would
// make it long are checked by `documentInputProblems` below instead.
const plainCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const objectCell = z.object({
  value: plainCell.optional().describe("Omit with `formula`. A percent is a fraction: 0.25."),
  formula: z.string().optional().describe('e.g. "=SUM(B2:B9)"'),
  format: z.enum(CELL_FORMATS).optional().describe("currency is R$ 1.234,56"),
  bold: z.boolean().optional(),
});
const cellSchema = z.union([plainCell, objectCell]);

export const sheetSchema = z.object({
  name: z.string().optional().describe("Tab name, 31 characters at most."),
  rows: z
    .array(z.array(cellSchema))
    .min(1)
    .describe(
      "Rows of cells: text, number, boolean, null or { value|formula, format, bold }. The FIRST row is the header.",
    ),
  columnWidths: z.array(z.number()).optional().describe("Widths in characters. Default: fitted."),
});
export type SheetInput = z.infer<typeof sheetSchema>;
export type SheetCell = z.infer<typeof cellSchema>;
export type SheetCellObject = z.infer<typeof objectCell>;

/** The look of a PDF or Word document. `academico` follows ABNT NBR 14724 (see the research). */
export const DOCUMENT_STYLES = ["padrao", "academico"] as const;
export type DocumentStyle = (typeof DOCUMENT_STYLES)[number];

/** The line that, alone in the Markdown, starts a new page (an HTML comment: shown nowhere). */
export const PAGE_BREAK_MARK = "<!-- pagebreak -->";

/** At most this many images in a document, each at most this size. */
export const MAX_DOCUMENT_IMAGES = 30;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const createDocumentInputSchema = z.object({
  format: z.enum(DOCUMENT_FORMATS).describe("pdf, docx (Word) or xlsx (Excel)."),
  name: z
    .string()
    .min(1)
    .describe(
      'File name the user sees, e.g. "historia-biblioteca.pdf" (extension added if missing).',
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Title shown at the top and stored in the file. Default: the content's first # heading, else the name.",
    ),
  style: z
    .enum(DOCUMENT_STYLES)
    .optional()
    .describe(
      "pdf/docx. padrao (default) or academico (ABNT NBR 14724: margins 3/2/2/3 cm, 12 pt, 1.5 spacing, justified; every figure needs a source).",
    ),
  maxPages: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("pdf: the most pages wanted; a longer result is refused so you can shorten it."),
  content: z
    .union([z.string().min(1).max(MAX_DOCUMENT_CHARS), z.array(sheetSchema).min(1).max(MAX_SHEETS)])
    .describe(
      `pdf/docx: the final text as Markdown (headings, **bold**, *italic*, [links](https://...), lists, | tables |, > quotes). Image: ![description](workspace/path.png "source"), PNG or JPEG from your workspace, never a URL. ${PAGE_BREAK_MARK} alone on a line starts a new page. Suup does the design; write no placeholders. xlsx: an array of sheets { name?, rows, columnWidths? }.`,
    ),
});
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

/** The size limits of the input (not in the schema the model sees): what is too big, in English. */
export function documentInputProblems(input: CreateDocumentInput): string[] {
  const out: string[] = [];
  if (input.name.length > 255) out.push("`name` is longer than 255 characters.");
  if ((input.title?.length ?? 0) > 300) out.push("`title` is longer than 300 characters.");
  if (input.maxPages !== undefined && input.maxPages > 1_000)
    out.push("`maxPages` is at most 1000.");
  const { content } = input;
  if (typeof content === "string") {
    if (content.length > MAX_DOCUMENT_CHARS) {
      out.push(
        `The text is longer than ${MAX_DOCUMENT_CHARS} characters: split it in two documents.`,
      );
    }
    return out;
  }
  if (content.length > MAX_SHEETS) out.push(`At most ${MAX_SHEETS} sheets.`);
  let cells = 0;
  for (const sheet of content) {
    if (sheet.rows.length > MAX_SHEET_ROWS)
      out.push(`A sheet has more than ${MAX_SHEET_ROWS} rows.`);
    for (const row of sheet.rows) {
      cells += row.length;
      if (row.length > MAX_SHEET_COLUMNS) {
        out.push(`A row has more than ${MAX_SHEET_COLUMNS} cells.`);
        break;
      }
      for (const cell of row) {
        const text =
          typeof cell === "string"
            ? cell
            : typeof cell === "object" && cell !== null
              ? cell.value
              : undefined;
        if (typeof text === "string" && text.length > MAX_CELL_CHARS) {
          out.push(`A cell has more than ${MAX_CELL_CHARS} characters.`);
        }
      }
    }
  }
  if (cells > MAX_SHEET_CELLS) out.push(`More than ${MAX_SHEET_CELLS} cells in all.`);
  return [...new Set(out)];
}

/** What the maker is asked to build: the input, checked, with the name already cleaned. */
export type DocumentRequest =
  | {
      format: "pdf" | "docx";
      name: string;
      title?: string;
      style: DocumentStyle;
      maxPages?: number;
      markdown: string;
    }
  | { format: "xlsx"; name: string; title?: string; sheets: SheetInput[] };

export interface MadeDocument {
  bytes: Uint8Array;
  mime: string;
  /** The title stored in the file (the given one, the first heading or the name). */
  title: string;
  /** Pages of a PDF (absent for the other formats: Word and Excel paginate when shown). */
  pages?: number;
  /** What was measured in the built file (pages, size, fonts, margins...), in English, for the bot. */
  facts: string[];
  /** What the maker changed, in English, for the model (a sheet name cut, a character missing). */
  notes: string[];
  /** The checks the built file passed before delivery (the tool reports them to the model). */
  checks: string[];
}

/**
 * A document is delivered only when it passed every check: a problem (an empty heading, a
 * placeholder left in, an image that is not in the workspace, a PDF longer than `maxPages`, a
 * check of the built file that failed) comes back to the bot, in English, and nothing is sent.
 */
export type MakeResult = { ok: true; document: MadeDocument } | { ok: false; problems: string[] };

/**
 * What opening a finished PDF, Word or Excel file again found: `problems` are what must be fixed
 * before it goes to the user (the file is not delivered), `facts` are what was measured, for the
 * bot and the reviewer to quote. In English, for the model.
 */
export interface DeliveryReport {
  problems: string[];
  facts: string[];
}

/**
 * Builds a document in the server process, with the author (the bot's name) bound in by whoever
 * provides it (the runtime). Never reaches the network or the disk while building.
 */
export interface DocumentMaker {
  /** The workspace paths of the images the content shows, for the tool to read (checked) first. */
  imagePaths(request: DocumentRequest): string[];
  /** Builds and verifies the file; `images` has the bytes of each path `imagePaths` gave. */
  make(request: DocumentRequest, images: ReadonlyMap<string, Uint8Array>): Promise<MakeResult>;
  /**
   * Opens any finished file (made by `create_document` or by the bot's own code) and measures it;
   * `null` when the type is not one it checks. `mime` is the type `detectFileType` decided.
   */
  inspect(file: { bytes: Uint8Array; mime: string }): Promise<DeliveryReport | null>;
}
