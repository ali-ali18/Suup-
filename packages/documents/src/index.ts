// Builds the documents the bot asks for (`create_document`): PDF, Word and Excel, in this process,
// from the content and the format only. Every file is opened again and checked before it is handed
// back; a file that fails a check is never returned (docs/pesquisas/ferramenta-de-documento.md).
import {
  DOCUMENT_MIME,
  type DocumentMaker,
  type DocumentRequest,
  type MakeResult,
} from "@suup/core";
import { buildDocx } from "./docx.js";
import { imagePathsOf, parseMarkdown } from "./markdown.js";
import { plain } from "./model.js";
import { buildPdf } from "./pdf.js";
import { CM, LOOKS } from "./style.js";
import { checkDocx, checkXlsx } from "./verify-office.js";
import { checkPdf } from "./verify-pdf.js";
import { buildXlsx } from "./xlsx.js";

export { parseMarkdown } from "./markdown.js";

export interface DocumentMakerOptions {
  /** The author stored in the file: the bot's name. */
  author: string;
}

function titleOf(request: DocumentRequest, firstHeading: string | undefined): string {
  const given = request.title?.trim();
  if (given !== undefined && given !== "") return given;
  if (firstHeading !== undefined && firstHeading.trim() !== "") return firstHeading.trim();
  const dot = request.name.lastIndexOf(".");
  return dot > 0 ? request.name.slice(0, dot) : request.name;
}

export function createDocumentMaker(options: DocumentMakerOptions): DocumentMaker {
  const author = options.author.trim() === "" ? "Suup" : options.author.trim();
  return {
    imagePaths(request) {
      return request.format === "xlsx" ? [] : imagePathsOf(parseMarkdown(request.markdown).blocks);
    },
    async make(request, images): Promise<MakeResult> {
      if (request.format === "xlsx") {
        const title = titleOf(request, undefined);
        const built = await buildXlsx({ sheets: request.sheets, title, author });
        if (built.problems.length > 0) return { ok: false, problems: built.problems };
        const check = checkXlsx(built.bytes, { title, author, sheets: built.expected });
        if (check.problems.length > 0) return { ok: false, problems: check.problems };
        return {
          ok: true,
          document: {
            bytes: built.bytes,
            mime: DOCUMENT_MIME.xlsx,
            title,
            notes: built.notes,
            checks: check.checks,
          },
        };
      }
      const parsed = parseMarkdown(request.markdown);
      if (parsed.problems.length > 0) return { ok: false, problems: parsed.problems };
      const first = parsed.blocks[0];
      const opensWithTitle = first?.kind === "heading" && first.depth === 1;
      const title = titleOf(request, opensWithTitle ? plain(first.inlines) : undefined);
      // The title shows at the top: the document's own first heading, or a block for the given one.
      const titleBlock = !opensWithTitle;
      if (request.format === "pdf") {
        const built = await buildPdf({
          blocks: parsed.blocks,
          title,
          author,
          style: request.style,
          titleBlock,
          images,
        });
        if (built.problems.length > 0) return { ok: false, problems: built.problems };
        const check = await checkPdf(built.bytes, {
          title,
          author,
          maxPages: request.maxPages,
          texts: built.expected,
          margins: {
            top: LOOKS[request.style].margin.top * CM,
            bottom: LOOKS[request.style].margin.bottom * CM,
          },
        });
        if (check.problems.length > 0) return { ok: false, problems: check.problems };
        return {
          ok: true,
          document: {
            bytes: built.bytes,
            mime: DOCUMENT_MIME.pdf,
            title,
            pages: check.pages,
            notes: parsed.notes,
            checks: check.checks,
          },
        };
      }
      const built = await buildDocx({
        blocks: parsed.blocks,
        title,
        author,
        style: request.style,
        titleBlock,
        images,
      });
      if (built.problems.length > 0) return { ok: false, problems: built.problems };
      const check = checkDocx(built.bytes, {
        title,
        author,
        style: request.style,
        texts: built.expected,
        tables: built.tables,
        figures: built.figures,
      });
      if (check.problems.length > 0) return { ok: false, problems: check.problems };
      return {
        ok: true,
        document: {
          bytes: built.bytes,
          mime: DOCUMENT_MIME.docx,
          title,
          notes: parsed.notes,
          checks: check.checks,
        },
      };
    },
  };
}
