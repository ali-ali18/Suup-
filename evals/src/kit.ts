import { createHash } from "node:crypto";
import type { ExecResult, Executor, StoredEvent } from "@suup/core";
import type { EvalCheck, VerifyContext, VerifyResult } from "./types.js";

/** The tools the loop handles itself. */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set(["plan", "finish", "escalate"]);

export function check(name: string, pass: boolean, detail?: string): EvalCheck {
  return detail === undefined ? { name, pass } : { name, pass, detail };
}

/** A result passes when every check does. */
export function result(
  checks: EvalCheck[],
  observations?: Record<string, string | number | boolean>,
): VerifyResult {
  const pass = checks.length > 0 && checks.every((c) => c.pass);
  return observations === undefined ? { pass, checks } : { pass, checks, observations };
}

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** The text of a workspace file, or `null` when it does not exist or cannot be read. */
export async function readText(ws: Executor, path: string): Promise<string | null> {
  try {
    return await ws.readFile(path);
  } catch {
    return null;
  }
}

export async function exists(ws: Executor, path: string): Promise<boolean> {
  try {
    return (await ws.stat(path)) !== null;
  } catch {
    return false;
  }
}

/** Single-quotes `text` for `sh`. */
export function sq(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Runs Python code (`python3 -c`) in the workspace. */
export function runPython(ws: Executor, code: string, timeoutMs = 60_000): Promise<ExecResult> {
  return ws.exec(`python3 -c ${sq(code)}`, { timeoutMs });
}

/** Writes `files` (path to content) into the workspace. */
export async function seed(ws: Executor, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await ws.writeFile(path, content);
}

/** Lines of a text, ignoring one final newline and any `\r`. */
export function linesOf(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// --- reading the event log -----------------------------------------------------------------

export interface ToolCallRecord {
  /** `seq` of the `tool_call` event. */
  seq: number;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: { seq: number; outcome: string; content: string; isError: boolean };
}

/** Every tool call in the log, with its result when there is one. */
export function toolCalls(events: readonly StoredEvent[]): ToolCallRecord[] {
  const calls = new Map<string, ToolCallRecord>();
  for (const event of events) {
    if (event.type === "tool_call") {
      const args =
        typeof event.payload.args === "object" &&
        event.payload.args !== null &&
        !Array.isArray(event.payload.args)
          ? (event.payload.args as Record<string, unknown>)
          : {};
      calls.set(event.payload.callId, {
        seq: event.seq,
        callId: event.payload.callId,
        name: event.payload.name,
        args,
      });
    } else if (event.type === "tool_result") {
      const call = calls.get(event.payload.callId);
      if (call !== undefined) {
        call.result = {
          seq: event.seq,
          outcome: event.payload.outcome,
          content: event.payload.content,
          isError: event.payload.isError,
        };
      }
    }
  }
  return [...calls.values()].sort((a, b) => a.seq - b.seq);
}

/** Calls of tools other than `plan`, `finish` and `escalate`. */
export const workCalls = (events: readonly StoredEvent[]): ToolCallRecord[] =>
  toolCalls(events).filter((c) => !CONTROL_TOOLS.has(c.name));

export function eventsOf<T extends StoredEvent["type"]>(
  events: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as never;
}

/** The questions the bot asked the user (not the reviewer tie-break), in order. */
export function escalations(events: readonly StoredEvent[]): { seq: number; question: string }[] {
  return eventsOf(events, "escalated")
    .filter((e) => e.payload.reason === undefined)
    .map((e) => ({ seq: e.seq, question: e.payload.question }));
}

/** The `seq` of the first accepted `finish` attempt, if there is one. */
export function acceptedFinishSeq(events: readonly StoredEvent[]): number | undefined {
  return eventsOf(events, "finish_attempt").find((e) => e.payload.accepted)?.seq;
}

/** What the run handed back (the summary of the move to `done`), if it finished. */
export function finalSummary(events: readonly StoredEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.type === "status_changed" && event.payload.to === "done") {
      return event.payload.result?.summary ?? "";
    }
  }
  return null;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The shell command of a `shell` call, or `undefined`. */
export const commandOf = (call: ToolCallRecord): string | undefined =>
  call.name === "shell" ? asString(call.args.command) : undefined;

/** The `path` argument of a file tool call, with a leading `./` removed. */
export function pathOf(call: ToolCallRecord): string | undefined {
  const path = asString(call.args.path);
  return path === undefined ? undefined : path.replace(/^\.\//, "");
}

/** Whether `command` mentions `file` as a whole word (not as part of a longer name). */
export function mentions(command: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w-])`).test(command);
}

const SHELL_WRITES =
  /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\btouch\b|\bdd\b|\binstall\b|\bpython3?\b)/;

/** A call that may change `file`: the file tools, or a shell command that names it and writes. */
export function writesTo(call: ToolCallRecord, file: string): boolean {
  if (call.name === "write_file" || call.name === "edit_file") return pathOf(call) === file;
  const command = commandOf(call);
  return command !== undefined && mentions(command, file) && SHELL_WRITES.test(command);
}

const SHELL_READS =
  /\b(cat|head|tail|less|more|diff|cmp|grep|rg|sed\s+-n|od|xxd|wc|nl|jq|python3?)\b/;

/** A call that reads `file` back: `read_file`, or a shell command that names it and shows it. */
export function readsFrom(call: ToolCallRecord, file: string): boolean {
  if (call.name === "read_file") return pathOf(call) === file;
  const command = commandOf(call);
  return command !== undefined && mentions(command, file) && SHELL_READS.test(command);
}

/** The exit code a shell call reported, when its result says one. */
export function exitCodeOf(call: ToolCallRecord): number | undefined {
  const match = /^exit code: (\d+)/.exec(call.result?.content ?? "");
  return match === null ? undefined : Number(match[1]);
}

/** The check every task shares: the run ended in the status the task expects. */
export function statusCheck(ctx: VerifyContext, expected: "done" | "waiting_user"): EvalCheck {
  return check(
    "estado final",
    ctx.run.status === expected,
    `esperado ${expected}, obtido ${ctx.run.status}`,
  );
}

/** Turns checks into a one-line description of the failures (for logs and messages). */
export function describeFailures(checks: readonly EvalCheck[]): string {
  return checks
    .filter((c) => !c.pass)
    .map((c) => (c.detail === undefined ? c.name : `${c.name} (${c.detail})`))
    .join("; ");
}
