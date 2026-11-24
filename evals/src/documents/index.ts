import type { EvalTask } from "../types.js";
import { abntPdf } from "./abnt-pdf.js";
import { type DocumentMode, documentTask } from "./kit.js";
import { reportPdf } from "./report-pdf.js";
import { salesXlsx } from "./sales-xlsx.js";

export type { DocumentMode } from "./kit.js";

const specs = [reportPdf, abntPdf, salesXlsx];

/**
 * The DOCUMENT set: the same three jobs (a report PDF, an ABNT-style PDF, a sales spreadsheet),
 * each in two modes. `-tool`: the bot has `create_document`. `-script`: it does not (and the
 * system prompt does not mention it), so it has to make the file with its terminal and Python. The
 * same code judges both: the file the bot DELIVERED, opened as a reader would. Not part of the
 * default run (`suup eval --tasks doc-report-pdf-tool,doc-report-pdf-script,...`).
 */
export const documentTasks: readonly EvalTask[] = specs.flatMap((spec) =>
  (["tool", "script"] as DocumentMode[]).map((mode) => documentTask(spec, mode)),
);

export { abntPdf, reportPdf, salesXlsx };
