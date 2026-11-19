import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDb } from "@suup/db";

export interface EmbeddedPostgresOptions {
  /** The folder of the PostgreSQL files (`bin`, `lib`, `share`): the `native` of the platform package. */
  home: string;
  /** Where the cluster lives (the app-data folder of this install). */
  dataDir: string;
  /** The server's own log (`pg_ctl -l`). */
  logFile: string;
  /** The superuser's password. Random, per install, kept by the app in the OS keychain. */
  password: string;
  port: number;
  user?: string;
  database?: string;
  /** Receives the output of the tools (initdb, pg_ctl) for the sidecar's log. */
  log?(text: string): void;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A PostgreSQL that belongs to the app: its binaries come with the app, the data is in the app-data
 * folder, it listens only on 127.0.0.1 and has no Unix socket. It is run with `pg_ctl`, which is
 * the portable way (Windows included) to start it, wait for it, ask it status and stop it gently.
 *
 * The server outlives this process on purpose (it is not a child of Node), so a crash of the sidecar
 * cannot cut a write in half: the next start finds it with `pg_ctl status` and stops it first.
 */
export class EmbeddedPostgres {
  readonly #o: Required<Pick<EmbeddedPostgresOptions, "user" | "database">> &
    EmbeddedPostgresOptions;

  constructor(options: EmbeddedPostgresOptions) {
    this.#o = { user: "suup", database: "suup", ...options };
  }

  get port(): number {
    return this.#o.port;
  }

  get user(): string {
    return this.#o.user;
  }

  get database(): string {
    return this.#o.database;
  }

  /** The connection URL of the app's database (the password is URL-encoded). */
  url(database: string = this.#o.database): string {
    return `postgres://${this.#o.user}:${encodeURIComponent(this.#o.password)}@127.0.0.1:${this.#o.port}/${database}`;
  }

  #exe(name: string): string {
    return join(this.#o.home, "bin", process.platform === "win32" ? `${name}.exe` : name);
  }

  #run(name: string, args: string[]): Promise<Ran> {
    return new Promise((resolve) => {
      execFile(
        this.#exe(name),
        args,
        { windowsHide: true, timeout: 180_000, env: { ...process.env, LC_MESSAGES: "C" } },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === "number" ? error.code : (1 as number);
          this.#o.log?.(`${name} ${args[0] ?? ""} -> ${code}\n${stdout}${stderr}`);
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  /** Whether the cluster was created already. */
  clusterExists(): boolean {
    return existsSync(join(this.#o.dataDir, "PG_VERSION"));
  }

  /** Whether a server is running on this data folder (`pg_ctl status`: exit 0 running, 3 not). */
  async isRunning(): Promise<boolean> {
    if (!this.clusterExists()) return false;
    return (await this.#run("pg_ctl", ["status", "-D", this.#o.dataDir])).code === 0;
  }

  /**
   * Creates the cluster: UTF-8, scram-sha-256 for everyone, and PostgreSQL's built-in `C.UTF-8`
   * locale provider (full Unicode case mapping on any system, nothing to install and no operating
   * system locale to depend on: "AÇÃO" and "ação" compare as they should on Windows too).
   */
  async init(): Promise<void> {
    mkdirSync(dirname(this.#o.dataDir), { recursive: true });
    const pwfile = join(dirname(this.#o.dataDir), `.pw-${process.pid}`);
    writeFileSync(pwfile, `${this.#o.password}\n`, { mode: 0o600 });
    try {
      const done = await this.#run("initdb", [
        "-D",
        this.#o.dataDir,
        "-U",
        this.#o.user,
        `--pwfile=${pwfile}`,
        "--auth=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
        "--locale-provider=builtin",
        "--builtin-locale=C.UTF-8",
        "--no-instructions",
      ]);
      if (done.code !== 0) throw new Error(`initdb falhou (código ${done.code}): ${done.stderr}`);
    } finally {
      rmSync(pwfile, { force: true });
    }
    // Loopback only, no Unix socket: nothing but this machine's TCP port 127.0.0.1 can reach it.
    appendFileSync(
      join(this.#o.dataDir, "postgresql.conf"),
      "\n# Suup\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n",
    );
  }

  /** Starts it and waits until it accepts connections. A server left by a crash is stopped first. */
  async start(): Promise<void> {
    if (!this.clusterExists()) await this.init();
    if (await this.isRunning()) await this.stop();
    const done = await this.#run("pg_ctl", [
      "start",
      "-D",
      this.#o.dataDir,
      "-w",
      "-t",
      "120",
      "-l",
      this.#o.logFile,
      "-o",
      `-p ${this.#o.port}`,
    ]);
    if (done.code !== 0) {
      throw new Error(`o PostgreSQL não subiu (código ${done.code}). Veja ${this.#o.logFile}.`);
    }
  }

  /** Stops it gently (fast shutdown: open sessions end, nothing is lost). Quiet when not running. */
  async stop(): Promise<void> {
    if (!(await this.isRunning())) return;
    const done = await this.#run("pg_ctl", [
      "stop",
      "-D",
      this.#o.dataDir,
      "-m",
      "fast",
      "-w",
      "-t",
      "90",
    ]);
    if (done.code !== 0) throw new Error(`o PostgreSQL não parou (código ${done.code})`);
  }

  /** Creates the app's database if it is not there (connecting to the maintenance one). */
  async ensureDatabase(): Promise<void> {
    const db = createDb(this.url("postgres"));
    try {
      const found =
        await db.sql`select 1 as one from pg_database where datname = ${this.#o.database}`;
      if (found.length === 0) {
        await db.sql.unsafe(
          `create database "${this.#o.database}" encoding 'UTF8' template template0 locale_provider builtin builtin_locale 'C.UTF-8' locale 'C'`,
        );
      }
    } finally {
      await db.close();
    }
  }
}
