import { defineTool, type Executor } from "@suup/core";
import { z } from "zod";
import { describeError } from "./util.js";

export const LIST_FILES_MAX_ENTRIES = 500;
export const LIST_FILES_MAX_DEPTH = 5;
/** Listed, but never descended into: huge and rarely what the model is after. */
const NOT_EXPANDED = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

const input = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to list, relative to the workspace root. Default: the workspace root."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(LIST_FILES_MAX_DEPTH)
    .optional()
    .describe(
      `How many levels to show: 1 = only the directory itself (default), 2 = also its subdirectories' contents, up to ${LIST_FILES_MAX_DEPTH}.`,
    ),
});

export const listFilesTool = defineTool({
  name: "list_files",
  description: [
    "Lists the files and directories in a workspace directory. Directories end with `/`.",
    `Use \`depth\` (up to ${LIST_FILES_MAX_DEPTH}) to see nested content as an indented tree. At most ${LIST_FILES_MAX_ENTRIES} entries are shown; the result says when it was cut, then list a narrower path.`,
    "node_modules, .git and similar directories are shown but not expanded. To find files by name pattern use the shell (`find`); to find text inside files use search_files.",
  ].join(" "),
  input,
  risk: "read",
  async execute({ path, depth }, ctx) {
    const root = path ?? ".";
    const maxDepth = depth ?? 1;
    let info: Awaited<ReturnType<Executor["stat"]>>;
    try {
      info = await ctx.executor.stat(root);
    } catch (error) {
      return { isError: true, content: describeError(error, root) };
    }
    if (info === null) {
      return {
        isError: true,
        content: `No such directory: ${JSON.stringify(root)}. List its parent directory to see what exists.`,
      };
    }
    if (info.kind === "file") {
      return {
        isError: true,
        content: `${JSON.stringify(root)} is a file (${info.size} bytes), not a directory. Use read_file to see its content.`,
      };
    }

    const lines: string[] = [];
    let shown = 0;
    let omitted = false;
    const walk = async (dir: string, level: number): Promise<void> => {
      let entries: Awaited<ReturnType<Executor["listDir"]>>;
      try {
        entries = await ctx.executor.listDir(dir);
      } catch (error) {
        lines.push(`${"  ".repeat(level - 1)}(cannot list ${dir}: ${describeError(error)})`);
        return;
      }
      // directories first, then files, each alphabetical
      entries.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      );
      for (const entry of entries) {
        if (shown >= LIST_FILES_MAX_ENTRIES) {
          omitted = true;
          return;
        }
        shown++;
        const indent = "  ".repeat(level - 1);
        if (entry.kind === "dir") {
          const expand = level < maxDepth && !NOT_EXPANDED.has(entry.name);
          lines.push(
            `${indent}${entry.name}/${level < maxDepth && !expand ? " (not expanded)" : ""}`,
          );
          if (expand)
            await walk(
              dir === "." ? entry.name : `${dir.replace(/\/$/, "")}/${entry.name}`,
              level + 1,
            );
          if (omitted) return;
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
    };
    await walk(root, 1);

    if (shown === 0) return { content: `${root} is empty.` };
    const header = `${root === "." ? "workspace root" : root} (${shown} entr${shown === 1 ? "y" : "ies"}${omitted ? ", list cut" : ""}):`;
    const footer = omitted
      ? `\n[Only the first ${LIST_FILES_MAX_ENTRIES} entries are shown. List a subdirectory, lower the depth, or use the shell (\`find\`) for the rest.]`
      : "";
    return { content: `${header}\n${lines.join("\n")}${footer}` };
  },
});
