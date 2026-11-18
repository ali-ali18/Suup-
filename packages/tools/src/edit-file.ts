import { defineTool } from "@suup/core";
import { z } from "zod";
import { describeError } from "./util.js";

const input = z.object({
  path: z.string().min(1).describe("File to edit, relative to the workspace root. It must exist."),
  old_string: z
    .string()
    .min(1)
    .describe(
      "The exact text to replace, character for character, including whitespace and indentation. Include enough surrounding lines to make it unique.",
    ),
  new_string: z
    .string()
    .describe("The text to put in its place. May be empty to delete old_string."),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of old_string instead of requiring exactly one. Default false.",
    ),
});

export const editFileTool = defineTool({
  name: "edit_file",
  description: [
    "Edits an existing text file by replacing an exact piece of text (`old_string`) with new text (`new_string`).",
    "Use it for targeted changes instead of rewriting the whole file. Read the file first (read_file) and copy `old_string` exactly from it, WITHOUT the line numbers that read_file prints.",
    "The edit fails, and nothing is changed, if old_string is not found or matches more than once; in the second case add surrounding context to make it unique, or set replace_all to true to change every match (useful for renaming).",
  ].join(" "),
  input,
  risk: "write",
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    if (old_string === new_string) {
      return {
        isError: true,
        content: "old_string and new_string are identical, so there is nothing to change.",
      };
    }
    let info: Awaited<ReturnType<typeof ctx.executor.stat>>;
    let text: string;
    try {
      info = await ctx.executor.stat(path);
      if (info === null) {
        return {
          isError: true,
          content: `No such file: ${JSON.stringify(path)}. edit_file only edits existing files; create it with write_file, or use list_files to find the right path.`,
        };
      }
      if (info.kind === "dir") {
        return { isError: true, content: `${JSON.stringify(path)} is a directory, not a file.` };
      }
      text = await ctx.executor.readFile(path);
    } catch (error) {
      return { isError: true, content: describeError(error, path) };
    }

    const positions = findAll(text, old_string);
    if (positions.length === 0) {
      const loose = collapseWhitespace(text).includes(collapseWhitespace(old_string));
      return {
        isError: true,
        content: `old_string was not found in ${path} (0 matches).${
          loose
            ? " The text exists when whitespace differences are ignored: check indentation, tabs vs spaces and line endings."
            : " Check for typos and make sure you did not include read_file's line numbers."
        } Read the file again and copy the text exactly.`,
      };
    }
    if (positions.length > 1 && replace_all !== true) {
      const where = positions
        .slice(0, 5)
        .map((p) => lineOf(text, p))
        .join(", ");
      return {
        isError: true,
        content: `old_string matches ${positions.length} places in ${path} (lines ${where}${positions.length > 5 ? ", ..." : ""}), so the edit is ambiguous and nothing was changed. Include more surrounding text in old_string to make it unique, or set replace_all to true to replace all ${positions.length}.`,
      };
    }

    const replaced =
      replace_all === true
        ? text.split(old_string).join(new_string)
        : replaceAt(text, positions[0] as number, old_string, new_string);
    try {
      await ctx.executor.writeFile(path, replaced);
    } catch (error) {
      return {
        isError: true,
        content: `Could not write ${JSON.stringify(path)}: ${describeError(error)}`,
      };
    }
    const count = replace_all === true ? positions.length : 1;
    return {
      content: `Edited ${path}: replaced ${count} occurrence${count === 1 ? "" : "s"} (first at line ${lineOf(text, positions[0] as number)}).`,
    };
  },
});

function findAll(text: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

function replaceAt(text: string, at: number, oldText: string, newText: string): string {
  return text.slice(0, at) + newText + text.slice(at + oldText.length);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
