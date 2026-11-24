import {
  CREATE_DOCUMENT_TOOL_NAME,
  cleanFileName,
  createDocumentInputSchema,
  type DocumentFormat,
  type DocumentRequest,
  defineTool,
  documentInputProblems,
  fileExtension,
  MAX_DOCUMENT_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_SENT_FILE_BYTES,
  WorkspaceEscapeError,
} from "@suup/core";
import { describeError } from "./util.js";

const MB = 1024 * 1024;

/**
 * Builds a PDF, Word or Excel file from the content the bot gives and hands it to the user's chat:
 * the same card under the bot's next message as `send_file`. Suup does the design and checks the
 * built file (`DocumentMaker`, bound by the runtime) before anything is delivered; a problem comes
 * back to the bot and nothing is sent. Risk `read`: the file goes to the user's own chat, and the
 * only thing read from the machine is the images the content names (through the workspace checks).
 */
export const createDocumentTool = defineTool({
  name: CREATE_DOCUMENT_TOOL_NAME,
  description: [
    "Creates a well-designed PDF, Word (docx) or Excel (xlsx) file from your content and delivers it to the user: it appears as a card under your message in the chat.",
    "A shortcut for a simple, standard PDF, Word or Excel document: you give only the content and Suup lays it out. For anything more custom, write your own code and use send_file (it checks the file too).",
    "You give only the final content (Markdown for pdf and docx, sheets of rows for xlsx); Suup does the design (A4, embedded fonts, spacing, tables, page numbers), checks the file and only then delivers it.",
    'The card shows the file, so never repeat its name in your text: one short line such as "Pronto, está aí." is enough.',
    `Up to ${MAX_SENT_FILE_BYTES / MB} MB; call it once per file.`,
  ].join(" "),
  input: createDocumentInputSchema,
  risk: "read",
  // The result only echoes what the harness built from the bot's own content.
  ownOutput: true,
  // Building and checking a long PDF takes a few seconds.
  timeoutMs: 120_000,
  describe: ({ name, format }) => `Create ${withExtension(name, format)}`,
  async execute(input, ctx) {
    if (ctx.files === undefined || ctx.documents === undefined) {
      return {
        isError: true,
        content:
          "Documents cannot be delivered in this run (there is no chat to deliver them to). Give the content in your answer instead.",
      };
    }
    const tooBig = documentInputProblems(input);
    if (tooBig.length > 0) return { isError: true, content: tooBig.join(" ") };
    const name = cleanFileName(withExtension(input.name, input.format));
    if (name === "") {
      return {
        isError: true,
        content: `Give the file a name with \`name\` (for example \`relatorio.${input.format}\`).`,
      };
    }
    const title = input.title?.trim() === "" ? undefined : input.title?.trim();
    let request: DocumentRequest;
    if (input.format === "xlsx") {
      if (typeof input.content === "string") {
        return {
          isError: true,
          content:
            'For xlsx, `content` is an array of sheets, each { "name": "...", "rows": [["header", ...], [1, 2, ...]] }, not text.',
        };
      }
      request = {
        format: "xlsx",
        name,
        ...(title === undefined ? {} : { title }),
        sheets: input.content,
      };
    } else {
      if (typeof input.content !== "string") {
        return {
          isError: true,
          content: `For ${input.format}, \`content\` is the document as Markdown text, not sheets. For a spreadsheet use format "xlsx".`,
        };
      }
      request = {
        format: input.format,
        name,
        ...(title === undefined ? {} : { title }),
        style: input.style ?? "padrao",
        ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
        markdown: input.content,
      };
    }

    const images = new Map<string, Uint8Array>();
    const paths = ctx.documents.imagePaths(request);
    if (paths.length > MAX_DOCUMENT_IMAGES) {
      return {
        isError: true,
        content: `The content shows ${paths.length} images; the most a document takes is ${MAX_DOCUMENT_IMAGES}. Use fewer images.`,
      };
    }
    if (paths.length > 0) {
      const read = ctx.executor.readFileBytes?.bind(ctx.executor);
      if (read === undefined) {
        return {
          isError: true,
          content: "This machine cannot hand images over: write the document without images.",
        };
      }
      for (const path of paths) {
        try {
          images.set(path, await read(path, MAX_IMAGE_BYTES));
        } catch (error) {
          return { isError: true, content: explainImage(error, path) };
        }
      }
    }

    const made = await ctx.documents.make(request, images);
    if (!made.ok) {
      return {
        isError: true,
        content: `The document was not delivered. Fix this and call create_document again:\n${made.problems.map((p) => `- ${p}`).join("\n")}`,
      };
    }
    const { document } = made;
    if (document.bytes.length > MAX_SENT_FILE_BYTES) {
      return {
        isError: true,
        content: `The document came out at ${(document.bytes.length / MB).toFixed(1)} MB; the limit is ${MAX_SENT_FILE_BYTES / MB} MB. Use fewer or smaller images, or split it in parts.`,
      };
    }
    const { id } = await ctx.files.send(
      { name, mime: document.mime, bytes: document.bytes },
      ctx.callId ?? `${ctx.runId}:${name}`,
    );
    const pages =
      document.pages === undefined
        ? ""
        : `, ${document.pages} page${document.pages === 1 ? "" : "s"}`;
    const measured =
      document.facts.length === 0 ? "" : ` Measured in the file: ${document.facts.join("; ")}.`;
    const notes = document.notes.length === 0 ? "" : ` Notes: ${document.notes.join(" ")}`;
    return {
      content: `Created and delivered ${JSON.stringify(name)} (${sizeText(document.bytes.length)}${pages}, file ${id}). Checked: ${document.checks.join("; ")}.${measured}${notes} It appears as a card under your next message: do not repeat its name; one short line is enough.`,
    };
  },
});

/** The name with the format's extension: added when the name has another one or none (exact). */
function withExtension(name: string, format: DocumentFormat): string {
  const trimmed = name.trim();
  return fileExtension(trimmed) === format ? trimmed : `${trimmed}.${format}`;
}

function explainImage(error: unknown, path: string): string {
  if (error instanceof WorkspaceEscapeError) {
    return `The image ${JSON.stringify(path)} is outside your workspace. Copy it into your workspace and use that path.`;
  }
  if (error instanceof Error && error.name === "FileTooLargeError") {
    return `The image ${JSON.stringify(path)} is larger than ${MAX_IMAGE_BYTES / MB} MB. Make it smaller first.`;
  }
  return `The image ${JSON.stringify(path)} could not be read: ${describeError(error, path)}`;
}

/** "3.0 KB", "1.2 MB": for the model, in English. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
