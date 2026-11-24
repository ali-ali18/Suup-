// Judges a PDF from what `inspectPdf` (the reader the document package itself uses) reports.
// Every number is measured from the file; nothing is read from how the bot says it made it.
import { inspectPdf, type PdfInspection } from "@suup/runtime";
import { check } from "../kit.js";

export { bodyLines, cm, dominantSize, type Layout, measureLayout } from "@suup/runtime";

import type { EvalCheck } from "../types.js";

export const CM = 28.3465;

/** Spaces and line breaks do not count when comparing text (justification splits words). */
export function squash(text: string): string {
  let out = "";
  for (const ch of text) if (ch.trim() !== "") out += ch;
  return out;
}

/** The text is in the file (spaces and letter case do not count; accents do). */
export const hasText = (pdf: PdfInspection, text: string): boolean =>
  pdf.flat.toLowerCase().includes(squash(text).toLowerCase());

/** The checks every PDF must pass, whatever it says: opens, A4, fonts, characters. */
export function commonPdfChecks(pdf: PdfInspection): EvalCheck[] {
  return [
    check("o PDF abre", pdf.pages >= 1, `${pdf.pages} página(s)`),
    check(
      "todas as páginas são A4",
      pdf.allA4,
      `${Math.round(pdf.pageSize.width)} x ${Math.round(pdf.pageSize.height)} pt`,
    ),
    check(
      "fontes embutidas",
      pdf.missingFonts.length === 0 && pdf.fonts.length > 0,
      pdf.missingFonts.length > 0
        ? `sem fonte embutida: ${pdf.missingFonts.join(", ")}`
        : `${pdf.fonts.length} fonte(s)`,
    ),
    check("texto sem caracteres quebrados", !pdf.brokenText),
  ];
}

export async function openPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return inspectPdf(bytes);
}
