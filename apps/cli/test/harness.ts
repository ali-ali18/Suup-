import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createDb, type Db } from "@suup/db";
import { afterAll, beforeAll } from "vitest";
import { type CliIo, main } from "../src/index.js";

export const DATABASE_URL = process.env.DATABASE_URL;

export const dbSuiteName = (name: string): string =>
  DATABASE_URL ? name : `${name} (skipped: DATABASE_URL is not set)`;

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** What a test can do while a command runs: watch its output, type, press Ctrl+C. */
export interface Handle {
  stdout(): string;
  /** Resolves when the output contains `text` (or fails after `timeoutMs`). */
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  /** Types a line on stdin. */
  send(line: string): void;
  /** One Ctrl+C. */
  interrupt(): void;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Whether stdin is a terminal (the CLI only reads answers and messages from a terminal). */
  tty?: boolean;
  /** Text piped to stdin (and stdin closed), as in `echo value | suup ...`. */
  input?: string;
  /** Runs alongside the command; the command's result is returned when both are done. */
  during?: (handle: Handle) => Promise<void>;
}

/** Calls the real `main` with injected streams: nothing is spawned. */
export async function runCli(argv: string[], options: RunOptions = {}): Promise<Result> {
  let out = "";
  let err = "";
  const watchers: { text: string; resolve(): void }[] = [];
  const stdin = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  const handlers = new Set<() => void>();

  const check = () => {
    for (const w of [...watchers]) {
      if (out.includes(w.text)) {
        watchers.splice(watchers.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const io: CliIo = {
    stdout: {
      write(chunk) {
        out += chunk;
        check();
        return true;
      },
    },
    stderr: {
      write(chunk) {
        err += chunk;
        return true;
      },
    },
    stdin,
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    onInterrupt(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const handle: Handle = {
    stdout: () => out,
    waitFor(text, timeoutMs = 10_000) {
      if (out.includes(text)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`timed out waiting for ${JSON.stringify(text)}; output so far:\n${out}`),
            ),
          timeoutMs,
        );
        watchers.push({
          text,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    send: (line) => void stdin.write(`${line}\n`),
    interrupt: () => {
      for (const handler of [...handlers]) handler();
    },
  };

  if (options.input !== undefined) stdin.end(options.input);
  const running = main(argv, io);
  const side = options.during?.(handle);
  // If the side script fails, the command may wait for ever: interrupt it, then report the failure.
  const sideFailure = side?.then(
    () => undefined,
    (error: unknown) => {
      handle.interrupt();
      handle.interrupt();
      return error;
    },
  );
  const code = await running;
  const failure = await sideFailure;
  if (failure !== undefined) {
    // Say what the command itself printed: the side script usually fails because of it.
    if (failure instanceof Error) failure.message += `\n--- stderr of the command:\n${err}`;
    throw failure;
  }
  return { code, stdout: out, stderr: err };
}

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suup-cli-test-"));
  temps.push(dir);
  return dir;
}

export interface Project {
  dir: string;
  /** The environment of every command: the isolated database and nothing else. */
  env: Record<string, string>;
  db: Db;
  /** Runs `suup` in the project directory. */
  suup(argv: string[], options?: RunOptions): Promise<Result>;
  /** Writes a scripted provider file in the project directory. */
  script(name: string, content: unknown): Promise<void>;
  /** Rewrites the configuration file with `overrides` on top of the default one. */
  config(overrides?: Record<string, unknown>): Promise<void>;
  /** The files under `workspace/bots/<botId>/`, read as text. */
  readBotFile(botId: string, path: string): Promise<string>;
}

export const DEFAULT_CONFIG = {
  providers: [
    { id: "roteiro", kind: "scripted", scriptPath: "roteiro.json" },
    { id: "outro", kind: "scripted", scriptPath: "outro.json" },
    { id: "nuvem", kind: "anthropic", apiKeyEnv: "SUUP_TEST_MISSING_KEY" },
  ],
  models: [
    {
      id: "model-x",
      provider: "roteiro",
      contextWindow: 100000,
      maxOutputTokens: 4096,
      pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    },
    { id: "model-y", provider: "outro", contextWindow: 100000, maxOutputTokens: 4096 },
    { id: "model-k", provider: "nuvem", contextWindow: 100000, maxOutputTokens: 4096 },
  ],
  reviewer: { model: "model-x" },
  sandbox: { kind: "local", root: "workspace" },
  // These tests drive the harness with scripted shell commands on the (not isolated) local machine:
  // the user's rule is "shell may run", so no card stops them. The approval flow has its own tests.
  // Nor does the model reviewer of "Auto-review" take part: it has its own tests.
  approvals: { levels: { shell: "write_reversible" }, autoReview: { enabled: false } },
  worker: { concurrency: 2, leaseRenewMs: 1000, staleAfterMs: 5000 },
  // The early brake and the asks check of chat runs (on by default) have their own tests.
  defaults: { maxTurns: 20, tasks: { handoff: { enabled: false }, askCheck: { enabled: false } } },
};

/**
 * A project directory with a configuration file and an isolated Postgres schema (dropped at the
 * end of the file). The schema is empty: `suup db migrate` is the first thing a test runs.
 */
export function useProject(): Project {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const project = {} as Project;
  let admin: Db | undefined;

  beforeAll(async () => {
    const base = DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is not set");
    admin = createDb(base, { max: 1 });
    await admin.sql.unsafe(`create schema ${schema}`);
    const url = new URL(base);
    url.searchParams.set("search_path", schema);
    project.dir = await tempDir();
    project.env = { DATABASE_URL: url.toString() };
    project.db = createDb(base, { schema });
    project.suup = (argv, options = {}) =>
      runCli(argv, { cwd: project.dir, ...options, env: { ...project.env, ...options.env } });
    project.script = async (name, content) => {
      await writeFile(join(project.dir, name), JSON.stringify(content, null, 2));
    };
    project.config = async (overrides = {}) => {
      await writeFile(
        join(project.dir, "suup.config.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }, null, 2),
      );
    };
    project.readBotFile = (botId, path) =>
      readFile(join(project.dir, "workspace", "bots", botId, path), "utf8");
    await mkdir(project.dir, { recursive: true });
    await project.config();
  });

  afterAll(async () => {
    await project.db?.close();
    if (admin) {
      await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  });

  return project;
}
