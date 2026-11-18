import { defineTool } from "@suup/core";
import { z } from "zod";
import { shellQuote } from "./shell-quote.js";
import { describeError } from "./util.js";

export const SEARCH_MAX_MATCHES = 100;
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_LINE_CHARS = 300;

const input = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Regular expression to look for in file contents. Use basic syntax that works in both ripgrep and grep -E (literals, ., [a-z], *, +, ?, |, (), ^, $); avoid \\d (write [0-9]). Escape special characters to match them literally, e.g. `foo\\(`.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search, relative to the workspace root. Default: the whole workspace.",
    ),
  glob: z
    .string()
    .optional()
    .describe("Only search files whose name matches this glob, e.g. `*.ts` or `*.{md,txt}`."),
  ignore_case: z.boolean().optional().describe("Match upper and lower case alike. Default false."),
});

export const searchFilesTool = defineTool({
  name: "search_files",
  description: [
    "Searches file contents under a path for a regular expression and returns matching lines as `path:line:text`.",
    "Use it to find where something is defined or used, or which file mentions a word, before reading files. Paths in the result can be passed straight to read_file.",
    `At most ${SEARCH_MAX_MATCHES} matching lines are returned (the result says when there are more: narrow the pattern, path or glob). Binary files, .git and node_modules are skipped; ripgrep also honors .gitignore.`,
    "To find files by NAME use list_files or the shell (`find`).",
  ].join(" "),
  input,
  risk: "read",
  timeoutMs: SEARCH_TIMEOUT_MS + 10_000,
  async execute({ pattern, path, glob, ignore_case }, ctx) {
    const target = path ?? ".";
    try {
      // Validates the path against the workspace (and symlinks) before it is used as an argument.
      const info = await ctx.executor.stat(target);
      if (info === null) {
        return {
          isError: true,
          content: `No such file or directory: ${JSON.stringify(target)}. Use list_files to find the right path.`,
        };
      }
    } catch (error) {
      return { isError: true, content: describeError(error, target) };
    }

    let command: string;
    try {
      command = buildSearchCommand({
        pattern,
        path: target,
        ...(glob === undefined ? {} : { glob }),
        ignoreCase: ignore_case === true,
      });
    } catch (error) {
      return { isError: true, content: describeError(error) };
    }

    let result: Awaited<ReturnType<typeof ctx.executor.exec>>;
    try {
      result = await ctx.executor.exec(command, {
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: ctx.signal,
      });
    } catch (error) {
      return { isError: true, content: describeError(error) };
    }
    if (result.timedOut) {
      return {
        isError: true,
        content: `The search took longer than ${SEARCH_TIMEOUT_MS / 1000}s and was stopped. Narrow it with \`path\` or \`glob\`, or use a more specific pattern.`,
      };
    }

    const matches = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (line.startsWith("./") ? line.slice(2) : line));
    // rg/grep: 0 = matches, 1 = none, 2 = error (possibly with partial matches)
    if (matches.length === 0) {
      if (result.exitCode === 1 || result.exitCode === 0) {
        return {
          content: `No matches for ${JSON.stringify(pattern)} in ${target}${glob === undefined ? "" : ` (files matching ${glob})`}.`,
        };
      }
      const detail = result.stderr.trim().split("\n").slice(0, 5).join("\n");
      return {
        isError: true,
        content: `The search failed (exit code ${result.exitCode ?? "none"}):\n${detail || "(no error output)"}\nIf this is a regex syntax error, simplify the pattern or escape special characters with a backslash.`,
      };
    }

    const shown = matches.slice(0, SEARCH_MAX_MATCHES).map(clip);
    const more = matches.length - shown.length;
    const notes: string[] = [];
    if (more > 0) {
      notes.push(
        `[${more}${result.stdout.includes("output truncated") ? "+" : ""} more matching lines not shown: narrow the pattern, path or glob.]`,
      );
    }
    if (result.exitCode === 2)
      notes.push(
        "[Some files could not be searched (see errors the tool hit); results may be incomplete.]",
      );
    return { content: [...shown, ...notes].join("\n") };
  },
});

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [... line cut]` : line;
}

/**
 * Builds the command line. Every value from the model goes through `shellQuote`; the rest is
 * constant. Uses ripgrep when installed and falls back to `grep -rnE`.
 */
export function buildSearchCommand(options: {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase: boolean;
}): string {
  const pattern = shellQuote(options.pattern);
  const path = shellQuote(options.path);
  const rg = [
    "rg --no-heading --line-number --color never --no-messages --max-columns 300 --max-columns-preview",
    options.ignoreCase ? "--ignore-case" : "",
    "--glob '!node_modules' --glob '!.git'",
    options.glob === undefined ? "" : `--glob ${shellQuote(options.glob)}`,
    `-e ${pattern} -- ${path}`,
  ];
  const grep = [
    "grep -rnEI --binary-files=without-match --exclude-dir=.git --exclude-dir=node_modules",
    options.ignoreCase ? "-i" : "",
    options.glob === undefined ? "" : `--include=${shellQuote(options.glob)}`,
    `-e ${pattern} -- ${path}`,
  ];
  const join = (parts: string[]) => parts.filter((p) => p !== "").join(" ");
  return `if command -v rg >/dev/null 2>&1; then ${join(rg)}; else ${join(grep)}; fi`;
}
