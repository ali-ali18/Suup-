// The two looks of a PDF or Word document, as numbers. A4 always. `academico` follows ABNT NBR 14724
// (docs/pesquisas/ferramenta-de-documento.md, "ABNT"): margins 3 cm top and left, 2 cm bottom and
// right; text 12 pt; line spacing 1.5; justified; first-line indent 1.25 cm (the usual practice,
// the norm does not state it); long quotes 4 cm in, 10 pt, single spaced; page number at the top
// right from the second page.
import type { DocumentStyle } from "@suup/core";

export const CM = 28.3465; // points per centimetre (72 / 2.54)
export const A4_PT = { width: 595.28, height: 841.89 };
/** A4 in twentieths of a point (Word's unit). */
export const A4_TWIPS = { width: 11906, height: 16838 };

export interface Look {
  /** Page margins in cm. */
  margin: { top: number; right: number; bottom: number; left: number };
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  justify: boolean;
  /** First-line indent of a paragraph in cm. */
  indentCm: number;
  /** Space after a paragraph in points. */
  paragraphGap: number;
  /** Heading sizes (h1..h6) in points. */
  headingSizes: number[];
  headingUpper: boolean;
  /** The page number: bottom "Página X de Y" or top right from page 2. */
  pageNumber: "footer" | "top-right";
  color: string;
  accent: string;
}

export const LOOKS: Readonly<Record<DocumentStyle, Look>> = {
  padrao: {
    margin: { top: 2.2, right: 2.2, bottom: 2.2, left: 2.2 },
    fontSize: 10.5,
    lineHeight: 1.4,
    justify: false,
    indentCm: 0,
    paragraphGap: 7,
    headingSizes: [22, 15, 12.5, 11, 10.5, 10.5],
    headingUpper: false,
    pageNumber: "footer",
    color: "#1a1a1a",
    accent: "#2f4b7c",
  },
  academico: {
    margin: { top: 3, right: 2, bottom: 2, left: 3 },
    fontSize: 12,
    lineHeight: 1.5,
    justify: true,
    indentCm: 1.25,
    paragraphGap: 0,
    headingSizes: [12, 12, 12, 12, 12, 12],
    headingUpper: true,
    pageNumber: "top-right",
    color: "#000000",
    accent: "#000000",
  },
};

/** ABNT: a quotation of more than three lines is set apart: 4 cm in, 10 pt, single spaced. */
export const LONG_QUOTE = { indentCm: 4, fontSize: 10, lineHeight: 1 };
/** Caption under a figure and its source line (ABNT: 10 pt, single spaced). */
export const CAPTION_SIZE = 10;
