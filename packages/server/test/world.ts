import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type StreamEvent, type Subscription, type SuupClient } from "@suup/api";
import type { Worker } from "@suup/core";
import { createDb, type Db, migrate } from "@suup/db";
import { createRuntime, parseConfig, type Runtime, type RuntimeConfig } from "@suup/runtime";
import { afterAll, beforeAll } from "vitest";
import { createServer, generateToken, type ServerOptions, type SuupServer } from "../src/index.js";

export const DATABASE_URL = process.env.DATABASE_URL;

export const dbSuiteName = (name: string): string =>
  DATABASE_URL ? name : `${name} (skipped: DATABASE_URL is not set)`;

/** Waits for a condition, polling: no fixed sleeps, so a slow machine only makes it take longer. */
export async function until<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export interface StartedServer {
  server: SuupServer;
  url: string;
  api: SuupClient;
  runtime: Runtime;
}

export interface World {
  schema: string;
  dir: string;
  /** The database as the tests read it. */
  db: Db;
  config: RuntimeConfig;
  token: string;
  /** The runtime of the API server (never runs a loop). */
  serverRuntime: Runtime;
  /** A separate runtime, on the same database, that works on the runs: "another process". */
  workerRuntime: Runtime;
  worker: Worker;
  /** The server and the real client of the default instance. */
  started: StartedServer;
  /** Writes a script of the scripted provider (before anything uses it). */
  script(name: string, content: unknown): Promise<void>;
  /** Another server instance on the same database (its own runtime), as a second process. */
  startServer(options?: Partial<ServerOptions>): Promise<StartedServer>;
}

export interface WorldOptions {
  scripts?: Record<string, unknown>;
  server?: Partial<ServerOptions>;
  config?: Record<string, unknown>;
  /** Extra environment variables of both runtimes (a vault key, for instance). */
  env?: Record<string, string>;
  /** Start a worker on `workerRuntime`. Default true. */
  worker?: boolean;
}

/**
 * Everything an end-to-end test of the server needs, around one isolated Postgres schema: a
 * temporary project directory with a configuration (scripted providers, local sandbox), a
 * runtime for the server and ANOTHER for the worker, the server on an ephemeral port and the real
 * `@suup/api` client. Torn down at the end of the file. Call inside a `describe`.
 */
export function useWorld(options: WorldOptions = {}): World {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const world = { schema } as World;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const base = DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is not set");
    const admin = createDb(base, { max: 1 });
    await admin.sql.unsafe(`create schema ${schema}`);
    cleanups.push(async () => {
      await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.close();
    });
    const url = new URL(base);
    url.searchParams.set("search_path", schema);
    const env = { DATABASE_URL: url.toString(), ...options.env };
    world.db = createDb(base, { schema });
    cleanups.unshift(() => world.db.close());
    await migrate(world.db);

    world.dir = await mkdtemp(join(tmpdir(), "suup-server-test-"));
    cleanups.push(() => rm(world.dir, { recursive: true, force: true }));
    world.script = async (name, content) => {
      await writeFile(join(world.dir, `${name}.json`), JSON.stringify(content, null, 2));
    };
    for (const [name, content] of Object.entries(options.scripts ?? {})) {
      await world.script(name, content);
    }
    world.config = parseConfig({
      providers: [
        { id: "roteiro", kind: "scripted", scriptPath: "roteiro.json" },
        { id: "outro", kind: "scripted", scriptPath: "outro.json" },
        { id: "nuvem", kind: "anthropic", apiKeyEnv: "SUUP_TEST_MISSING_KEY" },
      ],
      models: [
        {
          id: "model-x",
          provider: "roteiro",
          contextWindow: 100_000,
          maxOutputTokens: 4096,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
        { id: "model-y", provider: "outro", contextWindow: 100_000, maxOutputTokens: 4096 },
        { id: "model-k", provider: "nuvem", contextWindow: 100_000, maxOutputTokens: 4096 },
      ],
      sandbox: { kind: "local", root: "workspace" },
      approvals: { levels: { shell: "write_reversible" } },
      worker: { concurrency: 4, leaseRenewMs: 1000, staleAfterMs: 8000, controlPollMs: 100 },
      defaults: { maxTurns: 20 },
      ...options.config,
    });
    const runtimeOptions = { env, baseDir: world.dir };
    world.serverRuntime = createRuntime(world.config, runtimeOptions);
    world.workerRuntime = createRuntime(world.config, runtimeOptions);
    cleanups.unshift(() => world.workerRuntime.close());
    cleanups.unshift(() => world.serverRuntime.close());

    world.token = generateToken();
    const start = async (
      runtime: Runtime,
      extra: Partial<ServerOptions> = {},
    ): Promise<StartedServer> => {
      const server = createServer(runtime, {
        token: world.token,
        host: "127.0.0.1",
        port: 0,
        shutdownGraceMs: 500,
        ...options.server,
        ...extra,
      });
      const address = await server.listen();
      cleanups.unshift(() => server.close());
      return {
        server,
        url: address,
        runtime,
        api: createClient({ baseUrl: address, token: world.token }),
      };
    };
    world.started = await start(world.serverRuntime);
    world.startServer = async (extra) => {
      const runtime = createRuntime(world.config, runtimeOptions);
      cleanups.unshift(() => runtime.close());
      return start(runtime, { bootstrap: false, ...extra });
    };

    if (options.worker !== false) {
      world.worker = world.workerRuntime.createWorker({
        concurrency: 4,
        idleBackoff: { minMs: 15, maxMs: 80 },
        onError: (error, context) => {
          console.error(`worker: ${context}:`, error);
        },
      });
      world.worker.start();
      cleanups.unshift(() => world.worker.stop({ graceMs: 2000 }));
    }
  }, 60_000);

  afterAll(async () => {
    for (const f of openFollows) f.close();
    openFollows.clear();
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        console.error("cleanup failed:", error);
      }
    }
  }, 60_000);

  return world;
}

/** Every stream a test opened: closed before the servers, so nothing reconnects to a closed server. */
const openFollows = new Set<{ close(): void }>();

export interface Followed {
  readonly events: StreamEvent[];
  readonly sub: Subscription;
  /** Waits until an event that satisfies `check` is in `events` (searching from `from`). */
  waitFor(
    check: (event: StreamEvent) => boolean,
    what: string,
    from?: number,
    timeoutMs?: number,
  ): Promise<{ event: StreamEvent; index: number }>;
  close(): void;
}

/** Subscribes with the real client and keeps every event, for tests to wait on and inspect. */
export function follow(
  api: SuupClient,
  options: { runs?: string[]; lastEventId?: number } = {},
): Followed {
  const events: StreamEvent[] = [];
  const sub = api.subscribe({
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
    backoff: { minMs: 20, maxMs: 200 },
    onEvent: (event) => events.push(event),
    onError: (error) => console.error("stream error:", error.message),
  });
  const followed: Followed = {
    events,
    sub,
    async waitFor(check, what, from = 0, timeoutMs = 60_000) {
      return until(
        () => {
          for (let i = from; i < events.length; i++) {
            const event = events[i] as StreamEvent;
            if (check(event)) return { event, index: i };
          }
          return undefined;
        },
        what,
        timeoutMs,
      );
    },
    close: () => sub.close(),
  };
  openFollows.add(followed);
  return followed;
}
