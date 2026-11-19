// Owns ONE live connection to a connector's server: starting it (a child process or an HTTP
// session), the protocol handshake, listing tools, calling one, closing it. It does not decide
// when to connect, retry or reuse (the manager does). The protocol and the transports are the
// official SDK's; nothing here is an agent loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { ConnectorError } from "./errors.js";
import type { ConnectorSpec, ValueRef } from "./spec.js";
import { oneLineClean } from "./text.js";

/** A tool as a server describes it: all of it untrusted, kept as plain data. */
export interface RawTool {
  name: string;
  description: string | undefined;
  inputSchema: unknown;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
  /** The tool can only run as a long-running task, which this client does not support. */
  taskRequired: boolean;
}

export const MAX_TOOLS = 200;
const MAX_LIST_PAGES = 10;
/** A single protocol message larger than this closes the connection (it bounds memory). */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const STDERR_KEEP = 2000;

export interface ConnectionDeps {
  /** Values of the vault secrets a connector refers to. Never logged. */
  resolveSecrets(names: string[]): Promise<Record<string, string>>;
  redact(text: string): string;
  connectTimeoutMs: number;
  fetch?: typeof fetch | undefined;
  clientInfo: { name: string; version: string };
}

export interface Live {
  readonly client: Client;
  readonly transport: Transport;
  /** The transport reported that it closed (the server exited or the session ended). */
  closed: boolean;
  lastOkAt: number;
  /** The last bytes the server wrote to its error stream (stdio only), for diagnostics. */
  stderrTail(): string;
}

/** Accepts any structured output: the schemas are the server's, and compiling them would trust them. */
const acceptAnyOutput: jsonSchemaValidator = {
  getValidator:
    <T>(): JsonSchemaValidator<T> =>
    (input: unknown) => ({
      valid: true as const,
      data: input as T,
      errorMessage: undefined,
    }),
};

function resolveRef(
  ref: ValueRef,
  secrets: Record<string, string>,
  connector: string,
  what: string,
): string {
  if (typeof ref === "string") return ref;
  const value = secrets[ref.secret];
  if (value === undefined) {
    throw new ConnectorError(
      connector,
      "config",
      `o segredo ${ref.secret} (de ${what}) não está disponível no cofre.`,
    );
  }
  return `${ref.prefix ?? ""}${value}`;
}

/** Opens the connection: transport, handshake. Throws `ConnectorError`. */
export async function openConnection(
  spec: ConnectorSpec,
  deps: ConnectionDeps,
  now: () => number,
): Promise<Live> {
  const names = spec.transport.kind === "stdio" ? spec.transport.env : spec.transport.headers;
  const secretNames = Object.values(names).flatMap((r) =>
    typeof r === "string" ? [] : [r.secret],
  );
  let secrets: Record<string, string> = {};
  if (secretNames.length > 0) {
    try {
      secrets = await deps.resolveSecrets([...new Set(secretNames)]);
    } catch (error) {
      throw new ConnectorError(
        spec.name,
        "config",
        `não foi possível ler os segredos do conector (${deps.redact(errorText(error))}).`,
        error,
      );
    }
  }

  let transport: Transport;
  let stderrText = "";
  if (spec.transport.kind === "stdio") {
    const t = spec.transport;
    const env: Record<string, string> = {};
    for (const [key, ref] of Object.entries(t.env)) {
      env[key] = resolveRef(ref, secrets, spec.name, `a variável ${key}`);
    }
    // Explicit command and argument list, never a shell string; the child gets only the SDK's
    // safe defaults (HOME, PATH, USER...) plus the variables declared here, not our environment.
    const stdio = new StdioClientTransport({
      command: t.command,
      args: t.args,
      env,
      stderr: "pipe",
      maxBufferSize: MAX_MESSAGE_BYTES,
      ...(t.cwd === undefined ? {} : { cwd: t.cwd }),
    });
    // Always consumed (an unread pipe would stall the child), and only the last bytes are kept.
    stdio.stderr?.on("data", (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString("utf8")).slice(-STDERR_KEEP * 2);
    });
    transport = stdio;
  } else {
    const t = spec.transport;
    const headers: Record<string, string> = {};
    for (const [key, ref] of Object.entries(t.headers)) {
      headers[key] = resolveRef(ref, secrets, spec.name, `o cabeçalho ${key}`);
    }
    transport = new StreamableHTTPClientTransport(new URL(t.url), {
      requestInit: { headers },
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      // A single try per request: the manager owns reconnecting, with its own backoff.
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
  }

  // No capabilities: the server cannot ask us for sampling, roots or elicitation.
  const client = new Client(deps.clientInfo, {
    capabilities: {},
    jsonSchemaValidator: acceptAnyOutput,
  });
  const live: Live = {
    client,
    transport,
    closed: false,
    lastOkAt: now(),
    stderrTail: () => oneLineClean(deps.redact(stderrText), STDERR_KEEP),
  };
  client.onclose = () => {
    live.closed = true;
  };
  client.onerror = () => {
    // Transport noise (a stray write, a dropped stream): a broken connection shows up as `onclose`
    // and as the failure of the call that was waiting.
  };
  try {
    await client.connect(transport, { timeout: deps.connectTimeoutMs });
  } catch (error) {
    const tail = live.stderrTail();
    await closeQuietly(live);
    throw new ConnectorError(
      spec.name,
      "unavailable",
      `não foi possível conectar (${deps.redact(oneLineClean(errorText(error), 300))})${tail === "" ? "" : `; o servidor escreveu: ${tail.slice(-300)}`}.`,
      error,
    );
  }
  live.lastOkAt = now();
  return live;
}

/** Lists every tool (following the pages, with bounds). Throws what the SDK throws. */
export async function listAllTools(live: Live, signal?: AbortSignal): Promise<RawTool[]> {
  const out: RawTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await live.client.listTools(cursor === undefined ? {} : { cursor }, {
      timeout: 20_000,
      ...(signal === undefined ? {} : { signal }),
    });
    for (const tool of res.tools) {
      if (out.length >= MAX_TOOLS) return out;
      const hints = tool.annotations;
      out.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations:
          hints === undefined
            ? undefined
            : {
                ...(typeof hints.readOnlyHint === "boolean"
                  ? { readOnlyHint: hints.readOnlyHint }
                  : {}),
                ...(typeof hints.destructiveHint === "boolean"
                  ? { destructiveHint: hints.destructiveHint }
                  : {}),
              },
        taskRequired: tool.execution?.taskSupport === "required",
      });
    }
    cursor = res.nextCursor;
    if (cursor === undefined) break;
  }
  return out;
}

export async function closeQuietly(live: Live): Promise<void> {
  live.closed = true;
  try {
    await live.client.close();
  } catch {
    // already gone
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
