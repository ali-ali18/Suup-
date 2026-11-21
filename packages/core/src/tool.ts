import type { z } from "zod";
import type { OutboundMessage } from "./outbound.js";
import type { RiskLevel } from "./risk.js";
import type { WebAccess } from "./web.js";

/** Compatibility name of `RiskLevel` (see `risk.ts`). */
export type ToolRisk = RiskLevel;

export interface ExecOptions {
  /** Working directory, relative to the workspace root. Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface ExecResult {
  /** `null` when the process did not exit normally (killed by a signal, timed out). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
}

export interface FileStat {
  kind: "file" | "dir";
  size: number;
}

/**
 * The bot's machine. Implemented by the sandbox package; tools only ever see this interface.
 *
 * All paths are relative to the bot workspace. An implementation MUST reject any path that
 * escapes the workspace (`..` segments, absolute paths outside it, NUL bytes) by throwing
 * `WorkspaceEscapeError`. `resolveWorkspacePath` does the lexical part of that check; resolving
 * symlinks (a link inside the workspace pointing outside it) is the implementation's job, because
 * it needs the real filesystem.
 */
export interface Executor {
  /**
   * `true` when the machine is isolated from the user's own computer (a container). A tool may
   * read it to classify its risk (`shell` in a container only changes a disposable machine).
   * Absent or `false`: assume the commands reach the real computer.
   */
  readonly isolated?: boolean;
  /** Runs a shell command. Resolves (never rejects) for non-zero exits and timeouts. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Reads a UTF-8 text file. Rejects if it does not exist. */
  readFile(path: string): Promise<string>;
  /** Writes a UTF-8 text file, creating parent directories and replacing existing content. */
  writeFile(path: string, content: string): Promise<void>;
  /** Lists a directory (non-recursive). Rejects if it is not a directory. */
  listDir(path: string): Promise<DirEntry[]>;
  /** Returns `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
}

/** Thrown when a path would resolve outside the workspace root. */
export class WorkspaceEscapeError extends Error {
  override readonly name = "WorkspaceEscapeError";
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`path escapes the workspace (${reason}): ${JSON.stringify(path)}`);
    this.path = path;
  }
}

/**
 * Lexically resolves `relative` against the absolute POSIX `root` and returns the normalized
 * absolute path. Pure: no filesystem access, so symlinks are NOT handled here.
 *
 * Accepts relative paths and absolute paths that are inside `root`. Throws
 * `WorkspaceEscapeError` for `..` climbing above `root`, absolute paths outside it and NUL bytes.
 * An empty path or "." is the root itself. Backslashes are ordinary characters.
 */
export function resolveWorkspacePath(root: string, relative: string): string {
  if (!root.startsWith("/")) throw new Error(`workspace root must be absolute: ${root}`);
  if (relative.includes("\0")) throw new WorkspaceEscapeError(relative, "NUL byte");

  const rootSegments = normalizeSegments(root.split("/"), root, false);
  let segments: string[];
  if (relative.startsWith("/")) {
    segments = normalizeSegments(relative.split("/"), relative, true);
    const inside = rootSegments.every((segment, i) => segments[i] === segment);
    if (!inside) throw new WorkspaceEscapeError(relative, "absolute path outside the workspace");
  } else {
    segments = [...rootSegments];
    for (const part of relative.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (segments.length <= rootSegments.length) {
          throw new WorkspaceEscapeError(relative, "'..' above the workspace root");
        }
        segments.pop();
      } else {
        segments.push(part);
      }
    }
  }
  return `/${segments.join("/")}`;
}

function normalizeSegments(parts: string[], original: string, strict: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        if (strict) throw new WorkspaceEscapeError(original, "'..' above the filesystem root");
        continue;
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out;
}

export type MemoryLayerName = "rule" | "profile" | "note";
/** Layers `recall` can search: the three above plus the journal the runtime writes. */
export type RecallLayerName = MemoryLayerName | "journal";

/**
 * What the memory tools may do, with the bot, the run and the conversation already bound in by
 * whoever provides it (the runtime). Tools see only this interface, never the database. A bot
 * sees the shared memories and its own, nothing else.
 */
export interface MemoryService {
  /** Saves a memory. Throws a `MemoryRuleError` (see below) for a layer/scope combination that does not exist. */
  remember(
    input: {
      layer: MemoryLayerName;
      text: string;
      /** The short fact (at most 200 characters), searched together with the text. */
      summary?: string;
      scope?: "shared" | "bot";
    },
    /** What the run knows about itself, for the checks on a write (docs/MEMORIA.md). */
    run?: RunFacts,
  ): Promise<RememberResult>;
  recall(input: { query: string; layers?: RecallLayerName[]; limit?: number }): Promise<{
    hits: {
      id: string;
      layer: RecallLayerName;
      text: string;
      /** The passage around the match, as plain text. */
      excerpt: string;
      createdAt: Date;
    }[];
    /** `true` when no memory had ALL the words and these have at least one of them. */
    broader: boolean;
  }>;
  /** Forgets (archives) a memory visible to the bot. `false` when there is none with that id. */
  forget(input: { id: string }): Promise<boolean>;
  /** Full-text search over the past messages of the bot's conversations. */
  searchConversations(input: { query: string; limit?: number }): Promise<{
    hits: {
      conversationId: string;
      messageId: string;
      author: "user" | "bot" | "system";
      excerpt: string;
      createdAt: Date;
    }[];
    /** `true` when no message had ALL the words and these have at least one of them. */
    broader: boolean;
  }>;
}

/**
 * What a run tells the memory when the bot saves something: the user's own messages (oldest first)
 * and the names of the tools whose results the run has already received. The runtime decides, from
 * what each tool DECLARES (`ownOutput`), whether the run has read content from outside.
 */
export interface RunFacts {
  userMessages: readonly string[];
  toolsUsed: readonly string[];
}

/**
 * `active`: the memory counts from the next run. Nothing the bot writes waits for the user. `pending`
 * remains only for compatibility (an existing row). A write that the reviewer did not clear after the
 * run read content from outside is NOT saved: the service throws a `MemoryRuleError` that says why.
 */
export interface RememberResult {
  id: string;
  status: "active" | "pending";
  /** A note for the bot, in words it can pass on. */
  reason?: string;
}

/** Thrown by a `MemoryService` for a request that makes no sense (e.g. a shared note). The message is for the model. */
export class MemoryRuleError extends Error {
  override readonly name = "MemoryRuleError";
}

/**
 * What the network tool may do, with the bot and the run already bound in by whoever provides it
 * (the runtime). Granting is only ever reached AFTER the user approved the exact host on a card.
 */
export interface NetworkAccess {
  /** Allows ONE exact host for this run only. `added: false`: it was already allowed. Throws for an invalid host. */
  allowForRun(host: string): Promise<{ host: string; added: boolean }>;
}

/** Everything a tool may touch. Tools never reach the database, the provider or other tools. */
export interface ToolContext {
  runId: string;
  botId: string;
  executor: Executor;
  /** Aborted on cancellation or timeout. Long-running tools must honor it. */
  signal: AbortSignal;
  now(): Date;
  /** Present when the run has memory (the runtime provides it); the memory tools need it. */
  memory?: MemoryService;
  /** What the run knows about itself (the loop fills it), for checks on what the bot saves. */
  runFacts?: RunFacts;
  /** Present when the bot's machine reaches the internet through the egress proxy. */
  network?: NetworkAccess;
  /** Present when the runtime wired the web (search and the reader service); see `web.ts`. */
  web?: WebAccess;
}

export interface ToolOutput {
  /** Text handed back to the model. */
  content: string;
  /** The call failed; `content` should say why and how to fix it. */
  isError?: boolean;
  /**
   * The content came from outside (web pages, emails, files fetched from elsewhere). The registry
   * wraps it in an envelope marking it as data, not instructions (`wrapUntrusted`). A tool whose
   * whole output is external declares `externalOutput` instead.
   */
  untrusted?: boolean;
}

/** What `classify` may look at besides the arguments: the machine the call would run on. */
export interface ClassifyEnv {
  executor: Executor;
}

/**
 * A capability exposed to the model. A tool implements only the action: validation, risk gating,
 * secrets, timeouts, truncation and event logging are done around it by the registry and the
 * loop. A tool only DECLARES (its risk, which fields may receive secrets, whether its output comes
 * from outside); it never decides anything about permissions.
 */
export interface Tool<I = unknown> {
  /** `^[a-z][a-z0-9_]{0,63}$`. */
  name: string;
  /** Shown to the model: what it does and when to use it. */
  description: string;
  /** Input schema. Its JSON Schema form is what the model sees; it must describe an object. */
  input: z.ZodType<I>;
  /**
   * The default risk level of a call (plan, section 4.8). A call whose level depends on its
   * arguments also gives `classify`; a tool that declares neither is treated as
   * `external_irreversible`.
   */
  risk: RiskLevel;
  /**
   * The level of THIS call, from its (validated) arguments. It may only refine `risk`; if it
   * throws, the call counts as `external_irreversible`.
   */
  classify?(input: I, env: ClassifyEnv): RiskLevel;
  /** One line for the approval card: what exactly this call does. Default: the tool and its arguments. */
  describe?(input: I): string;
  /**
   * The argument fields that may carry a secret placeholder (`{{secret:NAME}}`), as dotted paths
   * into the input (`command`, `headers.*`: `*` stands for every key or item). The registry puts
   * the real value in at the moment of execution; a placeholder anywhere else is refused.
   */
  secretFields?: readonly string[];
  /**
   * The output comes from outside the system (web pages, files fetched from elsewhere, the output
   * of programs that may have fetched them). The registry labels it as untrusted data. A result
   * can also set `ToolOutput.untrusted` itself.
   */
  externalOutput?: boolean;
  /**
   * The output is only data the harness holds itself (the bot's own memory, the echo of its own
   * writes), never content that came from outside. Every other tool counts as "may have read
   * content from outside" for the checks on what the bot saves to memory; absent means it may have.
   */
  ownOutput?: boolean;
  /**
   * The call sends a message to another person (an e-mail and the like). Declared, never guessed:
   * `recipientFields` say where the recipients are in the input (dotted paths). The approval card
   * of such a call is the message card; every other tool's is plain Aprovar / Recusar. A call of a
   * tool that declares this is never `read`.
   */
  outbound?: OutboundMessage;
  /** Overrides the registry's default timeout. */
  timeoutMs?: number;
  /**
   * Runs the action with already-validated input. Throwing is allowed (it becomes a "crashed"
   * outcome), but expected failures should be returned as `{ isError: true }` with a helpful text.
   */
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** Identity helper that infers `I` from the zod schema. */
export function defineTool<I>(tool: Tool<I>): Tool<I> {
  return tool;
}
