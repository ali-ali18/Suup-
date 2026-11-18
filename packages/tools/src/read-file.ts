import { defineTool } from "@suup/core";
import { z } from "zod";
import { baseOf, describeError, parentOf, similarNames } from "./util.js";

export const READ_FILE_DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
/** Files above this size are refused unless the model reads them in slices with the shell. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const input = z.object({
  path: z.string().min(1).describe("File to read, relative to the workspace root."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start at (1-based). Default 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(READ_FILE_DEFAULT_LIMIT)
    .optional()
    .describe(`Maximum number of lines to return. Default and maximum ${READ_FILE_DEFAULT_LIMIT}.`),
});

export const readFileTool = defineTool({
  name: "read_file",
  description: [
    "Reads a text file from the workspace and returns it with line numbers (`   12\\tcode`). The numbers are not part of the file.",
    `Returns at most ${READ_FILE_DEFAULT_LIMIT} lines per call; for longer files continue with \`offset\` (the result says which offset comes next). Lines longer than ${MAX_LINE_CHARS} characters are cut.`,
    "Use it to read code, notes and data files before editing them. It refuses directories (use list_files) and binary files (use the shell, e.g. `file`, `unzip -l`, `python3`).",
  ].join(" "),
  input,
  risk: "read",
  async execute({ path, offset, limit }, ctx) {
    let info: Awaited<ReturnType<typeof ctx.executor.stat>>;
    try {
      info = await ctx.executor.stat(path);
    } catch (error) {
      return { isError: true, content: describeError(error, path) };
    }
    if (info === null) return { isError: true, content: await notFoundMessage(path, ctx.executor) };
    if (info.kind === "dir") {
      return {
        isError: true,
        content: `${JSON.stringify(path)} is a directory, not a file. Use list_files to see what is inside it.`,
      };
    }
    if (info.size > MAX_FILE_BYTES) {
      return {
        isError: true,
        content: `${JSON.stringify(path)} is too large to read whole (${info.size} bytes, limit ${MAX_FILE_BYTES}). Read part of it with the shell, e.g. \`sed -n '1,200p' ${path}\` or \`head -c 20000 ${path}\`, or search it with search_files.`,
      };
    }

    let text: string;
    try {
      text = await ctx.executor.readFile(path);
    } catch (error) {
      return { isError: true, content: describeError(error, path) };
    }
    if (looksBinary(text)) {
      return {
        isError: true,
        content: `${JSON.stringify(path)} looks like a binary file, not text. Inspect it with the shell instead (for example \`file ${path}\`, \`xxd ${path} | head\`, or a tool that understands the format).`,
      };
    }
    if (text === "") return { content: `(${path} is empty)` };

    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = offset ?? 1;
    if (start > total) {
      return {
        isError: true,
        content: `offset ${start} is past the end of ${JSON.stringify(path)}, which has ${total} line${total === 1 ? "" : "s"}. Use an offset between 1 and ${total}.`,
      };
    }
    const count = limit ?? READ_FILE_DEFAULT_LIMIT;
    const end = Math.min(total, start + count - 1);
    const width = String(end).length;
    const body = lines.slice(start - 1, end).map((line, i) => {
      let shown = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (shown.length > MAX_LINE_CHARS) {
        shown = `${shown.slice(0, MAX_LINE_CHARS)} [... line cut, ${shown.length - MAX_LINE_CHARS} more characters]`;
      }
      return `${String(start + i).padStart(Math.max(width, 4))}\t${shown}`;
    });
    const footer =
      end < total
        ? `\n[showing lines ${start}-${end} of ${total}; call again with offset=${end + 1} to continue]`
        : start > 1
          ? `\n[showing lines ${start}-${end} of ${total}]`
          : "";
    return { content: body.join("\n") + footer };
  },
});

/** Cheap check on the decoded text: NUL bytes, or many replacement/control characters. */
export function looksBinary(text: string): boolean {
  const sample = text.length > 8000 ? text.slice(0, 8000) : text;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12)) {
      suspicious++;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function notFoundMessage(
  path: string,
  executor: { listDir(path: string): Promise<{ name: string; kind: string }[]> },
): Promise<string> {
  const dir = parentOf(path);
  let hint = "";
  try {
    const entries = await executor.listDir(dir);
    const similar = similarNames(
      baseOf(path),
      entries.map((e) => e.name),
    );
    if (similar.length > 0) {
      const prefix = dir === "." ? "" : `${dir.replace(/\/$/, "")}/`;
      hint = ` Similar names in ${JSON.stringify(dir)}: ${similar.map((n) => JSON.stringify(prefix + n)).join(", ")}.`;
    } else {
      hint = ` The directory ${JSON.stringify(dir)} exists but has nothing with a similar name; use list_files to look around.`;
    }
  } catch {
    hint = ` The directory ${JSON.stringify(dir)} does not exist either; use list_files to find the right path.`;
  }
  return `No such file: ${JSON.stringify(path)}.${hint}`;
}
