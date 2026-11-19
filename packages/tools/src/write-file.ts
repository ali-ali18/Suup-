import { defineTool } from "@suup/core";
import { z } from "zod";
import { describeError, utf8Length } from "./util.js";

const input = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "File to write, relative to the workspace root. Missing parent directories are created.",
    ),
  content: z.string().describe("The complete new content of the file (UTF-8 text)."),
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: [
    "Creates a text file, or REPLACES an existing one completely, with the given content. Missing parent directories are created.",
    "Use it for new files and for rewriting a file from scratch. To change part of an existing file use edit_file instead: it is safer and cheaper, because write_file discards whatever was there before (read the file first if you are not sure what it contains).",
    "The result says whether the file was created or replaced and how many bytes were written. Text only; for binary files use the shell.",
  ].join(" "),
  input,
  risk: "write_reversible",
  ownOutput: true,
  describe: ({ path, content }) => `Write ${path} (${content.length} characters)`,
  async execute({ path, content }, ctx) {
    let existing: Awaited<ReturnType<typeof ctx.executor.stat>>;
    try {
      existing = await ctx.executor.stat(path);
    } catch (error) {
      return { isError: true, content: describeError(error, path) };
    }
    if (existing?.kind === "dir") {
      return {
        isError: true,
        content: `${JSON.stringify(path)} is a directory; choose a file path inside it, e.g. ${JSON.stringify(`${path.replace(/\/$/, "")}/notes.txt`)}.`,
      };
    }
    try {
      await ctx.executor.writeFile(path, content);
    } catch (error) {
      return {
        isError: true,
        content: `Could not write ${JSON.stringify(path)}: ${describeError(error)}. Check that no parent of the path is a regular file and that the path is inside the workspace.`,
      };
    }
    const bytes = utf8Length(content);
    return {
      content:
        existing === null
          ? `Created ${path} (${bytes} bytes).`
          : `Replaced ${path}: ${existing.size} bytes before, ${bytes} bytes now.`,
    };
  },
});
