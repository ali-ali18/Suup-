import { z } from "zod";
import type { JsonObject, JsonValue } from "./messages.js";
import type { OutboundMessage } from "./outbound.js";
import type { ToolSpec } from "./provider.js";
import { classifyCall, maxRisk, type RiskLevel } from "./risk.js";
import {
  noRedaction,
  pathAllowed,
  placeholderSites,
  type SecretAccess,
  SecretUnavailableError,
  substituteSecrets,
} from "./secrets.js";
import type { ClassifyEnv, Executor, Tool, ToolContext, ToolOutput, ToolSource } from "./tool.js";
import { wrapUntrusted } from "./untrusted.js";
import { WEB_URLS_PER_RESULT_MAX, type WebUrlSource } from "./web.js";

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export const TOOL_OUTCOMES = [
  "ok",
  "tool_error",
  "invalid_args",
  "unknown_tool",
  "timeout",
  "aborted",
  "crashed",
  "denied",
] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export interface ToolInvocation {
  /** What to hand back to the model (already truncated and, if needed, wrapped). */
  output: ToolOutput;
  durationMs: number;
  outcome: ToolOutcome;
  /** `output.content` is shorter than what the tool produced. */
  truncated: boolean;
  /** Workspace path of the full output when it was truncated and saved. */
  savedTo?: string;
}

export type BeforeExecuteResult = { allow: true } | { allow: false; reason: string };

/**
 * What the loop needs to know about a call BEFORE it may run: its level, a line for the approval
 * card and the secrets it names. Built from the arguments exactly as the model sent them
 * (placeholders still in place), after they passed validation.
 */
export interface ToolAssessment {
  level: RiskLevel;
  /** The call's arguments as they will run (placeholders, never values). */
  args: JsonValue;
  summary: string;
  /** What the tool declares it does (its own description, as the model reads it). */
  toolDescription: string;
  /** The secret names the arguments mention. */
  secrets: string[];
  /** Set only when the tool declares that the call is a message to another person. */
  outbound?: OutboundMessage;
}

export interface AssessOptions {
  /** Tools the bot may use (default: all). */
  allowed?: string[];
  /** The machine the call would run on (some tools classify differently on a real computer). */
  executor: Executor;
  /** The URLs the run has seen and where each came from (docs/BUSCA.md). */
  webSeen?: ReadonlyMap<string, WebUrlSource>;
}

export interface InvokeOptions {
  /** Tools the bot may use. A tool outside this list is reported as unknown. Default: all. */
  allowed?: string[];
  /** Gate run after validation and before execution (approvals plug in here). */
  beforeExecute?(
    tool: Tool<unknown>,
    input: unknown,
    ctx: ToolContext,
  ): Promise<BeforeExecuteResult>;
  /** Overrides the registry default for this call. */
  maxOutputChars?: number;
  /**
   * Where the values behind `{{secret:NAME}}` placeholders come from, and what scrubs them out of
   * the output. Without it a call that names a secret is refused.
   */
  secrets?: SecretAccess;
  /**
   * The id of the model's tool call. Names the spill file of a truncated output
   * (`.suup/outputs/<runId>/<callId>-<tool>.txt`), so a resumed run can never overwrite an earlier
   * file. Without it the registry falls back to an in-memory counter, which restarts with the
   * process.
   */
  callId?: string;
}

export interface ToolRegistryOptions {
  /** Default 120_000. A tool's own `timeoutMs` wins. */
  defaultTimeoutMs?: number;
  /** Default 20_000. */
  maxOutputChars?: number;
  /**
   * Names of tools whose output is labelled as untrusted data even though the tool does not
   * declare `externalOutput` (the user's choice: `untrustedOutputTools` in the configuration).
   */
  externalOutputTools?: readonly string[];
}

/**
 * Holds the tools of a run and runs them safely. `invoke` never throws: every failure becomes an
 * error `ToolOutput` the model can act on, with an `outcome` for the event log.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, { tool: Tool<unknown>; spec: ToolSpec }>();
  readonly #outputCounters = new Map<string, number>();
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #externalOutputTools: ReadonlySet<string>;

  constructor(options: ToolRegistryOptions = {}) {
    this.#externalOutputTools = new Set(options.externalOutputTools ?? []);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  register<I>(tool: Tool<I>): this {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN}`);
    }
    if (this.#tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    const inputSchema = toInputJsonSchema(tool);
    this.#tools.set(tool.name, {
      tool: tool as Tool<unknown>,
      spec: { name: tool.name, description: tool.description, inputSchema },
    });
    return this;
  }

  get(name: string): Tool<unknown> | undefined {
    return this.#tools.get(name)?.tool;
  }

  list(): Tool<unknown>[] {
    return [...this.#tools.values()].map((entry) => entry.tool);
  }

  /** Specs for the model, in registration order, optionally restricted to `allowed` names. */
  specs(allowed?: string[]): ToolSpec[] {
    const filter = allowed === undefined ? undefined : new Set(allowed);
    return [...this.#tools.values()]
      .filter((entry) => filter === undefined || filter.has(entry.tool.name))
      .map((entry) => structuredClone(entry.spec));
  }

  /**
   * The level and the card text of a call that is about to run, or `undefined` when there is
   * nothing to gate: an unknown or disallowed tool, or arguments that do not validate (`invoke`
   * answers those with an error and runs nothing).
   */
  assess(name: string, rawArgs: unknown, opts: AssessOptions): ToolAssessment | undefined {
    const visible = opts.allowed === undefined ? undefined : new Set(opts.allowed);
    const entry = this.#tools.get(name);
    if (entry === undefined || (visible !== undefined && !visible.has(name))) return undefined;
    const { tool } = entry;
    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) return undefined;
    const secrets = [...new Set(placeholderSites(rawArgs).flatMap((site) => site.names))];
    const env: ClassifyEnv = {
      executor: opts.executor,
      ...(opts.webSeen === undefined ? {} : { webSeen: opts.webSeen }),
    };
    let level = classifyCall(tool, parsed.data, env);
    // A call that carries a secret exists to prove who the user is to somebody else.
    if (secrets.length > 0) level = maxRisk(level, "external_irreversible");
    // A message to another person cannot be taken back: it is never a plain read.
    if (tool.outbound !== undefined) level = maxRisk(level, "external_irreversible");
    return {
      level,
      args: structuredClone(rawArgs) as JsonValue,
      summary: describeCall(tool, parsed.data, rawArgs, env),
      toolDescription: tool.description,
      secrets,
      ...(tool.outbound === undefined ? {} : { outbound: structuredClone(tool.outbound) }),
    };
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    opts: InvokeOptions = {},
  ): Promise<ToolInvocation> {
    const startedAt = Date.now();
    const redactor = opts.secrets?.redactor ?? noRedaction;
    // Everything handed back (errors included) is scrubbed of known secret values on its way out.
    const finish = (
      outcome: ToolOutcome,
      content: string,
      extra: { truncated?: boolean; savedTo?: string; output?: ToolOutput } = {},
    ): ToolInvocation => {
      const output = extra.output ?? { content, isError: true };
      return {
        output: { ...output, content: redactor.redact(output.content) },
        durationMs: Date.now() - startedAt,
        outcome,
        truncated: extra.truncated ?? false,
        ...(extra.savedTo === undefined ? {} : { savedTo: extra.savedTo }),
      };
    };

    const visible = opts.allowed === undefined ? undefined : new Set(opts.allowed);
    const entry = this.#tools.get(name);
    if (entry === undefined || (visible !== undefined && !visible.has(name))) {
      const names = [...this.#tools.keys()].filter((n) => visible === undefined || visible.has(n));
      return finish(
        "unknown_tool",
        `Unknown tool "${name}". Available tools: ${names.length > 0 ? names.join(", ") : "(none)"}.`,
      );
    }
    const { tool } = entry;

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return finish("invalid_args", renderIssues(name, parsed.error));
    }
    const input = parsed.data;

    if (ctx.signal.aborted) {
      return finish("aborted", abortedMessage(name));
    }

    // Placeholders are only allowed in the fields the tool declared; the real values go in last,
    // so neither the validation messages nor `beforeExecute` ever see them.
    let runInput: unknown = input;
    const sites = placeholderSites(input);
    if (sites.length > 0) {
      const declared = tool.secretFields ?? [];
      const misplaced = sites.find((site) => !pathAllowed(site.path, declared));
      if (misplaced !== undefined) {
        return finish(
          "invalid_args",
          `Tool "${name}" does not accept a secret placeholder in "${misplaced.path.join(".")}"${declared.length === 0 ? " (it accepts none)" : ` (allowed in: ${declared.join(", ")})`}. Write the value only where it is allowed.`,
        );
      }
      if (opts.secrets === undefined) {
        return finish(
          "tool_error",
          `Tool "${name}" names a secret, but no vault is configured for this run, so nothing was run.`,
        );
      }
      try {
        const values = await opts.secrets.resolve([...new Set(sites.flatMap((s) => s.names))]);
        runInput = substituteSecrets(input, values);
      } catch (error) {
        if (error instanceof SecretUnavailableError) return finish("tool_error", error.message);
        return finish(
          "crashed",
          `The vault could not be read (${errorMessage(error)}); tool "${name}" was not run.`,
        );
      }
    }

    if (opts.beforeExecute !== undefined) {
      try {
        const decision = await opts.beforeExecute(tool, input, ctx);
        if (!decision.allow) {
          return finish(
            "denied",
            `Tool call "${name}" was not allowed: ${decision.reason}. Do not retry it unchanged; choose another approach or ask the user.`,
          );
        }
      } catch (error) {
        return finish(
          "crashed",
          `The permission check for tool "${name}" failed (${errorMessage(error)}); the tool was not run.`,
        );
      }
    }

    const timeoutMs = tool.timeoutMs ?? this.#defaultTimeoutMs;
    const run = await runWithLimits(tool, runInput, ctx, timeoutMs);
    switch (run.kind) {
      case "timeout":
        return finish(
          "timeout",
          `Tool "${name}" timed out after ${formatSeconds(timeoutMs)}. It may have partly run: check the current state before retrying, and prefer a smaller step.`,
        );
      case "aborted":
        return finish("aborted", abortedMessage(name));
      case "crashed":
        return finish(
          "crashed",
          `Tool "${name}" crashed: ${errorMessage(run.error)}. This is a bug in the tool, not in your arguments; try a different approach.`,
        );
      case "returned":
        break;
    }

    const raw = run.output;
    if (typeof raw !== "object" || raw === null || typeof raw.content !== "string") {
      return finish(
        "crashed",
        `Tool "${name}" returned a malformed result (expected { content: string }).`,
      );
    }

    // Scrub BEFORE truncating: the full output is saved to a file when it is cut.
    const maxChars = opts.maxOutputChars ?? this.#maxOutputChars;
    const clipped = await this.#truncate(
      redactor.redact(raw.content),
      name,
      ctx,
      maxChars,
      opts.callId,
    );
    const external =
      raw.untrusted === true || tool.externalOutput === true || this.#externalOutputTools.has(name);
    const content = external ? wrapUntrusted(name, clipped.content) : clipped.content;
    const output: ToolOutput = { content };
    if (raw.isError === true) output.isError = true;
    if (external) output.untrusted = true;
    if (Array.isArray(raw.webUrls) && raw.webUrls.length > 0) {
      output.webUrls = raw.webUrls
        .filter((u): u is string => typeof u === "string")
        .slice(0, WEB_URLS_PER_RESULT_MAX);
    }
    if (raw.urlProvenance !== undefined) output.urlProvenance = raw.urlProvenance;
    const source = sourceOf(raw.source);
    if (source !== undefined) output.source = source;
    return finish(raw.isError === true ? "tool_error" : "ok", content, {
      output,
      truncated: clipped.truncated,
      ...(clipped.savedTo === undefined ? {} : { savedTo: clipped.savedTo }),
    });
  }

  async #truncate(
    content: string,
    toolName: string,
    ctx: ToolContext,
    maxChars: number,
    callId: string | undefined,
  ): Promise<{ content: string; truncated: boolean; savedTo?: string }> {
    if (content.length <= maxChars) return { content, truncated: false };

    let key: string;
    if (callId !== undefined && callId !== "") {
      key = sanitizePathPart(callId);
    } else {
      const n = (this.#outputCounters.get(ctx.runId) ?? 0) + 1;
      this.#outputCounters.set(ctx.runId, n);
      key = String(n);
    }
    const path = `.suup/outputs/${sanitizePathPart(ctx.runId)}/${key}-${toolName}.txt`;

    let saved = true;
    try {
      await ctx.executor.writeFile(path, content);
    } catch {
      saved = false;
    }

    let headLength = Math.floor(maxChars * 0.6);
    let tailLength = maxChars - headLength;
    // Do not cut a surrogate pair in half.
    if (isHighSurrogate(content.charCodeAt(headLength - 1))) headLength -= 1;
    if (isLowSurrogate(content.charCodeAt(content.length - tailLength))) tailLength -= 1;
    const omitted = content.length - headLength - tailLength;
    const marker = saved
      ? `\n\n[... ${omitted} characters omitted. Full output saved to ${path} (read it in parts if you need the middle) ...]\n\n`
      : `\n\n[... ${omitted} characters omitted. The full output could not be saved ...]\n\n`;
    return {
      content: content.slice(0, headLength) + marker + content.slice(content.length - tailLength),
      truncated: true,
      ...(saved ? { savedTo: path } : {}),
    };
  }
}

type RunResult =
  | { kind: "returned"; output: ToolOutput }
  | { kind: "crashed"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

async function runWithLimits(
  tool: Tool<unknown>,
  input: unknown,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<RunResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const interrupted = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
      controller.abort(new Error("tool timed out"));
    }, timeoutMs);
    onAbort = () => {
      resolve({ kind: "aborted" });
      controller.abort(ctx.signal.reason);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  const execution = (async (): Promise<RunResult> => {
    try {
      const output = await tool.execute(input, { ...ctx, signal: controller.signal });
      return { kind: "returned", output };
    } catch (error) {
      return { kind: "crashed", error };
    }
  })();

  try {
    return await Promise.race([execution, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) ctx.signal.removeEventListener("abort", onAbort);
  }
}

function toInputJsonSchema(tool: Tool<unknown>): JsonObject {
  const schema = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as JsonObject;
  if (schema.type !== "object") {
    throw new Error(`tool "${tool.name}": input schema must describe an object`);
  }
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function renderIssues(toolName: string, error: z.ZodError): string {
  const maxIssues = 8;
  const lines = error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.map(String).join(".");
    return `- ${path === "" ? "(arguments)" : path}: ${issue.message}`;
  });
  const extra = error.issues.length - maxIssues;
  if (extra > 0) lines.push(`- ... and ${extra} more problem(s)`);
  return `Invalid arguments for tool "${toolName}":\n${lines.join("\n")}\nFix the arguments and call the tool again.`;
}

const SUMMARY_ARGS_CHARS = 300;

/** The line of the approval card: the tool's own words, or its name and clipped arguments. */
function describeCall(
  tool: Tool<unknown>,
  input: unknown,
  rawArgs: unknown,
  env: ClassifyEnv,
): string {
  if (tool.describe !== undefined) {
    try {
      const text = tool.describe(input, env);
      if (typeof text === "string" && text.trim() !== "") return text.trim();
    } catch {
      // fall through to the default
    }
  }
  const json = JSON.stringify(rawArgs) ?? "{}";
  const clipped =
    json.length <= SUMMARY_ARGS_CHARS ? json : `${json.slice(0, SUMMARY_ARGS_CHARS)}…`;
  return `${tool.name} ${clipped}`;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}

/** The page a tool declared (`ToolOutput.source`), bounded; anything malformed is dropped. */
function sourceOf(raw: unknown): ToolSource | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { url, title } = raw as { url?: unknown; title?: unknown };
  if (typeof url !== "string" || url === "" || url.length > SOURCE_URL_MAX) return undefined;
  return typeof title === "string" && title.trim() !== ""
    ? { url, title: title.trim().slice(0, SOURCE_TITLE_MAX) }
    : { url };
}

const SOURCE_URL_MAX = 2048;
const SOURCE_TITLE_MAX = 200;

function abortedMessage(name: string): string {
  return `Tool "${name}" was interrupted before it finished. The result is unknown: check the current state before repeating it.`;
}

function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
