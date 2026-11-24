import {
  cleanFileName,
  defineTool,
  detectFileType,
  MAX_SENT_FILE_BYTES,
  SEND_FILE_TOOL_NAME,
  WorkspaceEscapeError,
} from "@suup/core";
import { z } from "zod";
import { describeError } from "./util.js";

const input = z.object({
  path: z
    .string()
    .min(1)
    .describe("The file to send, relative to the workspace root (or absolute inside it)."),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "The name the user sees and saves it as, with its extension. Default: the file's own name.",
    ),
});

const MB = 1024 * 1024;

/**
 * Hands a file the bot made on its machine to the user: it shows as a card under the bot's message
 * in the chat, to open or save. Risk `read`: the file goes to the user's own chat, on the user's
 * own server, and nothing leaves for anyone else. The path goes through the machine's workspace
 * checks (`stat` and `readFileBytes`, symlinks included); the type comes from the file's first
 * bytes and its extension (`detectFileType`, exact tables, never a pattern).
 */
export const sendFileTool = defineTool({
  name: SEND_FILE_TOOL_NAME,
  description: [
    "Sends a file from your workspace to the user: it appears under your message in the chat, with its name and size, for them to open or save.",
    "Use it whenever you make a file for the user (a PDF, a document, a spreadsheet, an image, a zip). Writing the path in your message is not enough: the user cannot reach your machine.",
    `Up to ${MAX_SENT_FILE_BYTES / MB} MB per file; call it once per file.`,
  ].join(" "),
  input,
  risk: "read",
  // The result only echoes what the harness did with the bot's own file.
  ownOutput: true,
  describe: ({ path }) => `Send ${path} to the user`,
  async execute({ path, name }, ctx) {
    if (ctx.files === undefined) {
      return {
        isError: true,
        content:
          "Files cannot be sent to the user in this run (there is no chat to deliver them to). Tell the user where the file is instead.",
      };
    }
    const read = ctx.executor.readFileBytes?.bind(ctx.executor);
    if (read === undefined) {
      return { isError: true, content: "This machine cannot hand files over." };
    }
    let info: Awaited<ReturnType<typeof ctx.executor.stat>>;
    try {
      info = await ctx.executor.stat(path);
    } catch (error) {
      return { isError: true, content: explain(error, path) };
    }
    if (info === null) {
      return {
        isError: true,
        content: `${JSON.stringify(path)} does not exist. Check the path with list_files, or create the file first.`,
      };
    }
    if (info.kind === "dir") {
      return {
        isError: true,
        content: `${JSON.stringify(path)} is a directory. Send one file at a time; to send a folder, make a zip of it first (e.g. \`zip -r pasta.zip pasta\`) and send the zip.`,
      };
    }
    if (info.size > MAX_SENT_FILE_BYTES) {
      return { isError: true, content: tooLarge(path, info.size) };
    }
    const shown = cleanFileName(name ?? path);
    if (shown === "") {
      return {
        isError: true,
        content: "Give the file a name with `name` (for example `relatorio.pdf`).",
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await read(path, MAX_SENT_FILE_BYTES);
    } catch (error) {
      return { isError: true, content: explain(error, path) };
    }
    if (bytes.length > MAX_SENT_FILE_BYTES) {
      return { isError: true, content: tooLarge(path, bytes.length) };
    }
    const { mime } = detectFileType(bytes, shown);
    const { id } = await ctx.files.send(
      { name: shown, mime, bytes },
      ctx.callId ?? `${ctx.runId}:${path}`,
    );
    return {
      content: `Sent ${JSON.stringify(shown)} (${sizeText(bytes.length)}, ${mime}) to the user (file ${id}). It appears under your next message as a card they can open or save: do not repeat the path; say in one line what the file is.`,
    };
  },
});

function explain(error: unknown, path: string): string {
  if (error instanceof WorkspaceEscapeError) {
    return `${JSON.stringify(path)} is outside your workspace, so it cannot be sent. Copy it into your workspace first (for example \`cp ${path} .\`) and send the copy.`;
  }
  if (error instanceof Error && error.name === "FileTooLargeError") return tooLarge(path, null);
  return describeError(error, path);
}

function tooLarge(path: string, size: number | null): string {
  return `${JSON.stringify(path)} is too large to send${size === null ? "" : ` (${sizeText(size)})`}: the limit is ${MAX_SENT_FILE_BYTES / MB} MB. Make it smaller (compress it, lower the image quality, split it) and send it again.`;
}

/** "3.0 KB", "1.2 MB": for the model, in English. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
