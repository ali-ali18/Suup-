// Judges a PDF from what `inspectPdf` (the reader the document package itself uses) reports.
// Every number is measured from the file; nothing is read from how the bot says it made it.
import { inspectPdf, type PdfInspection, type PdfLine } from "@suup/runtime";
import { check } from "../kit.js";
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

const isDigitsOnly = (text: string): boolean => {
  const t = text.trim();
  return t !== "" && [...t].every((ch) => ch >= "0" && ch <= "9");
};

/** The page number sits alone on its line (a number, or "Página 1 de 2" style text is not one). */
export const bodyLines = (pdf: PdfInspection): PdfLine[] =>
  pdf.lines.filter((l) => l.text.trim() !== "" && !isDigitsOnly(l.text));

/** The font size most of the characters are set in, to the half point. */
export function dominantSize(lines: readonly PdfLine[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const size = Math.round(l.size * 2) / 2;
    weight.set(size, (weight.get(size) ?? 0) + l.text.length);
  }
  let best = 0;
  let most = -1;
  for (const [size, w] of weight) {
    if (w > most) {
      best = size;
      most = w;
    }
  }
  return best;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export const cm = (points: number): number => Math.round((points / CM) * 100) / 100;

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

export interface Layout {
  fontSize: number;
  /** Measured from the text on the page, in cm. */
  leftCm: number;
  rightCm: number;
  topCm: number;
  bottomCm: number;
  /** The median distance between the baselines of consecutive body lines, over the font size. */
  lineSpacing: number;
  /** The share of body lines that end at the right edge of the text. */
  justifiedShare: number;
  bodyWords: number;
}

/** Measures the body text of a PDF: font size, margins, line spacing and justification. */
export function measureLayout(pdf: PdfInspection): Layout {
  const lines = bodyLines(pdf);
  const size = dominantSize(lines);
  const body = lines.filter((l) => Math.abs(l.size - size) < 0.6 && l.text.trim().length >= 20);
  const height = pdf.pageSize.height;
  const width = pdf.pageSize.width;
  const left = Math.min(...lines.map((l) => l.left));
  const right = Math.max(...lines.map((l) => l.right));
  const top = Math.max(...lines.map((l) => l.y + l.size * 0.72));
  const bottom = Math.min(...lines.map((l) => l.y - l.size * 0.22));
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) {
    const prev = body[i - 1] as PdfLine;
    const line = body[i] as PdfLine;
    if (prev.page !== line.page) continue;
    const gap = prev.y - line.y;
    if (gap >= size * 0.8 && gap <= size * 3) gaps.push(gap);
  }
  const reachRight = Math.max(...body.map((l) => l.right));
  const words = body.filter((l) => l.text.split(" ").filter((w) => w !== "").length >= 3);
  const justified = words.filter((l) => reachRight - l.right <= 2).length;
  return {
    fontSize: size,
    leftCm: cm(left),
    rightCm: cm(width - right),
    topCm: cm(height - top),
    bottomCm: cm(bottom),
    lineSpacing: gaps.length === 0 ? 0 : Math.round((median(gaps) / size) * 100) / 100,
    justifiedShare: words.length === 0 ? 0 : Math.round((justified / words.length) * 100) / 100,
    bodyWords: lines.reduce((sum, l) => sum + l.text.split(" ").filter((w) => w !== "").length, 0),
  };
}

export async function openPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return inspectPdf(bytes);
}
