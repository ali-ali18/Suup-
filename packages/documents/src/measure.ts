// Measures the layout of a PDF from the text on its pages: font size, margins, line spacing and
// justification. The numbers come from the file, never from how its maker says it was made. The
// evaluation of documents and the delivery check (`deliver.ts`) read the same measurements.
import type { PdfInspection, PdfLine } from "./inspect.js";
import { CM } from "./style.js";

function isDigitsOnly(text: string): boolean {
  const t = text.trim();
  return t !== "" && [...t].every((ch) => ch >= "0" && ch <= "9");
}

/** The lines that are not a lone page number. */
export function bodyLines(pdf: PdfInspection): PdfLine[] {
  return pdf.lines.filter((l) => l.text.trim() !== "" && !isDigitsOnly(l.text));
}

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
  if (lines.length === 0) {
    return {
      fontSize: 0,
      leftCm: 0,
      rightCm: 0,
      topCm: 0,
      bottomCm: 0,
      lineSpacing: 0,
      justifiedShare: 0,
      bodyWords: 0,
    };
  }
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
  const reachRight = body.length === 0 ? 0 : Math.max(...body.map((l) => l.right));
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
