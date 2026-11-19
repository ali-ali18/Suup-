import { defineTool } from "@suup/core";
import { z } from "zod";
import { describeError } from "./util.js";

export const SHELL_DEFAULT_TIMEOUT_SECONDS = 120;
export const SHELL_MAX_TIMEOUT_SECONDS = 600;

const input = z.object({
  command: z
    .string()
    .min(1)
    .describe("The shell command line, run with `sh -c`. Pipes, redirects and `&&` work."),
  cwd: z
    .string()
    .optional()
    .describe("Directory to run in, relative to the workspace root. Default: the workspace root."),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(SHELL_MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Kill the command (and everything it started) after this many seconds. Default ${SHELL_DEFAULT_TIMEOUT_SECONDS}, maximum ${SHELL_MAX_TIMEOUT_SECONDS}.`,
    ),
});

export const shellTool = defineTool({
  name: "shell",
  description: [
    "Runs a shell command on your Linux machine and returns its exit code, stdout and stderr.",
    "Use it for anything the other tools do not cover: running programs and scripts, installing packages, git, curl, text processing, running tests.",
    "Each call is a fresh shell: `cd` and exported variables do not carry over to the next call, so pass `cwd` or chain commands with `&&`. Files you create do persist in the workspace.",
    "Commands cannot ask for input (stdin is closed): pass flags like `-y` instead of waiting for a prompt. Do not start servers or other long-running processes in the foreground: the call ends when the command exits or the timeout kills it.",
    `Output is limited; redirect large output to a file and read parts of it. Timeout: default ${SHELL_DEFAULT_TIMEOUT_SECONDS}s, maximum ${SHELL_MAX_TIMEOUT_SECONDS}s.`,
    "A non-zero exit code is reported, not treated as a tool failure: read stderr and decide.",
  ].join(" "),
  input,
  // The command is arbitrary and is NOT parsed (no heuristic pretends to be security). What
  // decides is where it runs: on the isolated machine of the bot it can only change a disposable
  // machine; on the user's own computer (the `local` sandbox) it reaches everything. A command that
  // carries a secret placeholder is raised to `external_irreversible` by the registry.
  risk: "external_irreversible",
  classify: (_input, { executor }) =>
    executor.isolated === true ? "write_reversible" : "external_irreversible",
  describe: ({ command, cwd }) =>
    `Shell${cwd === undefined ? "" : ` in ${cwd}`}: ${command.length > 500 ? `${command.slice(0, 500)}…` : command}`,
  secretFields: ["command"],
  // What a command prints may have come from the network, but labelling every output would change
  // what the model reads on every call: `untrustedOutputTools` in the configuration turns it on.
  timeoutMs: (SHELL_MAX_TIMEOUT_SECONDS + 15) * 1000,
  async execute({ command, cwd, timeout_seconds }, ctx) {
    const seconds = timeout_seconds ?? SHELL_DEFAULT_TIMEOUT_SECONDS;
    let result: Awaited<ReturnType<typeof ctx.executor.exec>>;
    try {
      result = await ctx.executor.exec(command, {
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs: seconds * 1000,
        signal: ctx.signal,
      });
    } catch (error) {
      return { isError: true, content: describeError(error, cwd) };
    }

    const lines: string[] = [];
    if (result.timedOut) {
      lines.push(
        `TIMED OUT after ${seconds}s: the command and its child processes were killed. Output captured before that is below.`,
        "Next: run something shorter, split the work into steps, run it with a higher timeout_seconds (max " +
          `${SHELL_MAX_TIMEOUT_SECONDS}), or redirect output to a file.`,
      );
    } else if (result.exitCode === null) {
      lines.push("exit code: none (the command was killed before it finished)");
    } else {
      lines.push(`exit code: ${result.exitCode}`);
    }
    lines.push(
      "--- stdout ---",
      result.stdout === "" ? "(empty)" : stripFinalNewline(result.stdout),
    );
    lines.push(
      "--- stderr ---",
      result.stderr === "" ? "(empty)" : stripFinalNewline(result.stderr),
    );
    return { content: lines.join("\n"), ...(result.timedOut ? { isError: true } : {}) };
  },
});

function stripFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
