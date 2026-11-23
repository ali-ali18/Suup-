// Owns the connections of one process (a worker, the server, the CLI): they are opened lazily at
// the first use, reused, health-checked when they have been idle, reconnected with a backoff after a
// failure and closed at shutdown. A connector that is down never throws into the loop: callers get a
// `ConnectorError` naming the connector, which the tool adapter turns into a tool error.
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type ConnectionDeps,
  closeQuietly,
  errorText,
  type Live,
  listAllTools,
  openConnection,
  type RawTool,
  type StdioLauncher,
} from "./connection.js";
import { ConnectorError } from "./errors.js";
import type { ConnectorSpec } from "./spec.js";
import { oneLineClean } from "./text.js";

const CONNECTION_CLOSED = -32000;
const REQUEST_TIMEOUT = -32001;

export interface ManagerOptions {
  /** The values of the vault secrets a connector's configuration refers to (by name). */
  resolveSecrets(names: string[]): Promise<Record<string, string>>;
  /** Scrubs known secret values out of text that may be shown or logged. Default: unchanged. */
  redact?(text: string): string;
  now?(): number;
  /** Default 15 s. */
  connectTimeoutMs?: number;
  /** A connection idle for longer than this is pinged before it is used again. Default 30 s. */
  healthIntervalMs?: number;
  /** Default 5 s. */
  pingTimeoutMs?: number;
  /** How long a list of tools stays fresh. Default 5 min. */
  listTtlMs?: number;
  /** After a failed connection, the next attempt waits `baseMs * 2^(failures-1)`, up to `maxMs`. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** The `fetch` the HTTP transport uses (tests). */
  fetch?: typeof fetch;
  /** Runs stdio servers isolated (a container). Without it they are child processes of this process. */
  launcher?: StdioLauncher;
  /** Called when a fresh list of tools was read from a server (the runtime stores it). */
  onListed?(connector: string, tools: RawTool[]): void;
  /** The OAuth provider of a connector that logs in with the OAuth of the protocol. */
  oauthProvider?: ConnectionDeps["oauthProvider"];
}

interface Slot {
  live?: Live | undefined;
  key?: string | undefined;
  connecting?: Promise<Live> | undefined;
  failures: number;
  retryAt: number;
  lastError?: string | undefined;
  list?: { key: string; at: number; tools: RawTool[] } | undefined;
}

export interface ConnectorStatus {
  connector: string;
  connected: boolean;
  failures: number;
  /** Waiting out a backoff until this time (ms since the epoch), or 0. */
  retryAt: number;
  lastError: string | undefined;
}

export interface TestReport {
  serverName: string;
  serverVersion: string;
  tools: RawTool[];
  durationMs: number;
}

export interface CallOutcome {
  /** The protocol's result, untrusted. */
  result: unknown;
}

const keyOf = (spec: ConnectorSpec): string =>
  JSON.stringify({ v: spec.version, t: spec.transport });

export class ConnectorManager {
  readonly #slots = new Map<string, Slot>();
  readonly #opts: Required<
    Pick<ManagerOptions, "connectTimeoutMs" | "healthIntervalMs" | "pingTimeoutMs" | "listTtlMs">
  >;
  readonly #backoff: { baseMs: number; maxMs: number };
  readonly #now: () => number;
  readonly #redact: (text: string) => string;
  readonly #deps: ConnectionDeps;
  readonly #onListed: ManagerOptions["onListed"];
  #closed = false;

  constructor(options: ManagerOptions) {
    this.#now = options.now ?? Date.now;
    this.#redact = options.redact ?? ((t) => t);
    this.#onListed = options.onListed;
    this.#opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      healthIntervalMs: options.healthIntervalMs ?? 30_000,
      pingTimeoutMs: options.pingTimeoutMs ?? 5_000,
      listTtlMs: options.listTtlMs ?? 300_000,
    };
    this.#backoff = {
      baseMs: options.backoff?.baseMs ?? 500,
      maxMs: options.backoff?.maxMs ?? 30_000,
    };
    this.#deps = {
      resolveSecrets: options.resolveSecrets,
      redact: this.#redact,
      connectTimeoutMs: this.#opts.connectTimeoutMs,
      fetch: options.fetch,
      launcher: options.launcher,
      clientInfo: { name: "suup", version: "0.0.0" },
      oauthProvider: options.oauthProvider,
    };
  }

  #slot(name: string): Slot {
    let slot = this.#slots.get(name);
    if (slot === undefined) {
      slot = { failures: 0, retryAt: 0 };
      this.#slots.set(name, slot);
    }
    return slot;
  }

  /** Where stdio servers run: `container` (isolated) or `host` (a child process of this one, unisolated). */
  get stdioIsolation(): "container" | "host" {
    return this.#deps.launcher?.where ?? "host";
  }

  status(): ConnectorStatus[] {
    return [...this.#slots.entries()].map(([connector, s]) => ({
      connector,
      connected: s.live !== undefined && !s.live.closed,
      failures: s.failures,
      retryAt: s.retryAt,
      lastError: s.lastError,
    }));
  }

  /** The tools of a connector: from memory when fresh, else read from the server. */
  async tools(
    spec: ConnectorSpec,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<RawTool[]> {
    const slot = this.#slot(spec.name);
    const key = keyOf(spec);
    const cached = slot.list;
    if (
      options.refresh !== true &&
      cached !== undefined &&
      cached.key === key &&
      this.#now() - cached.at < this.#opts.listTtlMs
    ) {
      return cached.tools;
    }
    const live = await this.#acquire(spec, options.signal);
    let tools: RawTool[];
    try {
      tools = await listAllTools(live, options.signal);
    } catch (error) {
      throw this.#failed(spec, slot, live, error, options.signal);
    }
    live.lastOkAt = this.#now();
    slot.list = { key, at: this.#now(), tools };
    try {
      this.#onListed?.(spec.name, tools);
    } catch {
      // storing the snapshot must never fail a listing
    }
    return tools;
  }

  /** The last list this process read, however old (for a fallback when the server is down). */
  lastKnownTools(spec: ConnectorSpec): RawTool[] | undefined {
    const list = this.#slots.get(spec.name)?.list;
    return list !== undefined && list.key === keyOf(spec) ? list.tools : undefined;
  }

  async callTool(
    spec: ConnectorSpec,
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallOutcome> {
    const slot = this.#slot(spec.name);
    const live = await this.#acquire(spec, options.signal);
    try {
      const result = await live.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: options.timeoutMs ?? spec.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      live.lastOkAt = this.#now();
      return { result };
    } catch (error) {
      throw this.#failed(spec, slot, live, error, options.signal);
    }
  }

  /**
   * Checks a configuration from scratch on a connection of its own (not the pooled one, so the
   * backoff and an old session cannot hide a broken setup): connects, lists, closes.
   */
  async test(spec: ConnectorSpec, signal?: AbortSignal): Promise<TestReport> {
    const startedAt = this.#now();
    const live = await openConnection(spec, this.#deps, this.#now);
    try {
      const tools = await listAllTools(live, signal);
      const info = live.client.getServerVersion();
      try {
        this.#onListed?.(spec.name, tools);
      } catch {
        // see above
      }
      return {
        serverName: oneLineClean(info?.name ?? "?", 80),
        serverVersion: oneLineClean(info?.version ?? "?", 40),
        tools,
        durationMs: this.#now() - startedAt,
      };
    } catch (error) {
      throw this.#failed(spec, undefined, live, error, signal);
    } finally {
      await closeQuietly(live);
    }
  }

  /** Forgets the connection and the cached list of a connector (it was changed or removed). */
  async invalidate(name: string): Promise<void> {
    const slot = this.#slots.get(name);
    if (slot === undefined) return;
    this.#slots.delete(name);
    const live = slot.live ?? (await slot.connecting?.catch(() => undefined));
    if (live !== undefined) await closeQuietly(live);
  }

  /** Closes every connection (and stops the child processes). */
  async close(): Promise<void> {
    this.#closed = true;
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    await Promise.all(
      slots.map(async (slot) => {
        const live = slot.live ?? (await slot.connecting?.catch(() => undefined));
        if (live !== undefined) await closeQuietly(live);
      }),
    );
  }

  // --- connections ---------------------------------------------------------------------------

  async #acquire(spec: ConnectorSpec, signal?: AbortSignal): Promise<Live> {
    if (this.#closed)
      throw new ConnectorError(spec.name, "unavailable", "o gerenciador foi encerrado.");
    if (signal?.aborted)
      throw new ConnectorError(spec.name, "aborted", "cancelado antes de conectar.");
    const slot = this.#slot(spec.name);
    const key = keyOf(spec);
    if (slot.live !== undefined && slot.key !== key) {
      // The connector was edited: what was opened with the old settings must not serve the new.
      const old = slot.live;
      slot.live = undefined;
      slot.list = undefined;
      await closeQuietly(old);
    }
    if (slot.live?.closed === true) slot.live = undefined;
    if (slot.live !== undefined) {
      const idle = this.#now() - slot.live.lastOkAt;
      if (idle > this.#opts.healthIntervalMs) {
        try {
          await slot.live.client.ping({
            timeout: this.#opts.pingTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          });
          slot.live.lastOkAt = this.#now();
        } catch (error) {
          if (signal?.aborted) throw new ConnectorError(spec.name, "aborted", "cancelado.");
          // Dead or unresponsive: close it and fall through to a fresh connection (right away: a
          // connection that went quiet is not a failure to connect).
          const dead = slot.live;
          slot.live = undefined;
          await closeQuietly(dead);
          slot.lastError = this.#redact(oneLineClean(errorText(error), 200));
        }
      }
    }
    if (slot.live !== undefined) return slot.live;

    if (slot.connecting === undefined) {
      const wait = slot.retryAt - this.#now();
      if (wait > 0) {
        throw new ConnectorError(
          spec.name,
          "unavailable",
          `indisponível; nova tentativa de conexão em ${Math.ceil(wait / 1000)} s (${slot.failures} falha(s) seguidas${slot.lastError === undefined ? "" : `; última: ${slot.lastError}`}).`,
        );
      }
      const attempt = openConnection(spec, this.#deps, this.#now).then(
        (live) => {
          slot.live = live;
          slot.key = key;
          slot.failures = 0;
          slot.retryAt = 0;
          slot.lastError = undefined;
          return live;
        },
        (error: unknown) => {
          slot.failures += 1;
          slot.retryAt =
            this.#now() +
            Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** (slot.failures - 1));
          slot.lastError = this.#redact(oneLineClean(errorText(error), 300));
          throw error;
        },
      );
      slot.connecting = attempt.finally(() => {
        slot.connecting = undefined;
      });
      slot.connecting.catch(() => {});
    }
    return await raceAbort(slot.connecting, signal, spec.name);
  }

  /** Classifies a failure of a call, drops a connection that is no longer good, and says it by name. */
  #failed(
    spec: ConnectorSpec,
    slot: Slot | undefined,
    live: Live,
    error: unknown,
    signal: AbortSignal | undefined,
  ): ConnectorError {
    if (error instanceof ConnectorError) return error;
    const text = this.#redact(oneLineClean(errorText(error), 300));
    if (signal?.aborted === true) {
      return new ConnectorError(spec.name, "aborted", "a chamada foi cancelada.", error);
    }
    if (error instanceof McpError && error.code === REQUEST_TIMEOUT) {
      return new ConnectorError(spec.name, "timeout", "o servidor não respondeu a tempo.", error);
    }
    if (error instanceof McpError && error.code !== CONNECTION_CLOSED) {
      // The server understood and refused (bad arguments, unknown tool): the connection is fine.
      // What it said is its own text, untrusted: the tool result wraps it as external data.
      return new ConnectorError(
        spec.name,
        "rejected",
        `o servidor recusou o pedido: ${text}`,
        error,
      );
    }
    // The connection broke (the server exited, the session ended, the network dropped): drop it so
    // the next call reconnects. The state of an action that was in flight is unknown.
    live.closed = true;
    if (slot !== undefined && slot.live === live) slot.live = undefined;
    const tail = live.stderrTail();
    void closeQuietly(live);
    return new ConnectorError(
      spec.name,
      "closed",
      `a conexão com o servidor caiu (${text})${tail === "" ? "" : `; o servidor escreveu: ${tail.slice(-200)}`}.`,
      error,
    );
  }
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  name: string,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new ConnectorError(name, "aborted", "cancelado."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ConnectorError(name, "aborted", "cancelado."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
