import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type CliIo, main as cli } from "@suup/cli";
import { createDb, migrate } from "@suup/db";
import { SEARXNG_IMAGE } from "@suup/web/engines";
import { buildConfig } from "./config.js";
import { type AppImages, chooseIsolation, prepareWebImages } from "./docker.js";
import { createLogger, rotateIfBig, scrubber } from "./log.js";
import { choosePorts } from "./ports.js";
import { EmbeddedPostgres } from "./postgres.js";
import { encodeEvent, type SidecarEvent, type Stage } from "./protocol.js";

/** What the app tells the sidecar, all through the environment (nothing on the command line). */
export interface SidecarEnv {
  appData: string;
  /** The folder with `postgres/`, `migrations/` and `docker/`. */
  resources: string;
  pgPassword: string;
  serverToken: string;
  vaultKey: string;
  /** The model provider's key, if the owner has typed one. */
  apiKey: string | undefined;
  /** Ties the Docker images to the app's version: a new version builds its own. */
  version: string;
  dockerPath: string;
  /** Force the bots' machine (tests): `local` skips Docker altogether. */
  sandbox: "auto" | "local";
}

const REQUIRED = {
  appData: "SUUP_APP_DATA",
  resources: "SUUP_RESOURCES",
  pgPassword: "SUUP_PG_PASSWORD",
  serverToken: "SUUP_SERVER_TOKEN",
  vaultKey: "SUUP_VAULT_KEY",
} as const;

/** Reads the environment; the error names the missing variable (never a value). */
export function readEnv(env: Record<string, string | undefined>): SidecarEnv {
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`falta a variável ${name}`);
    return value;
  };
  return {
    appData: need(REQUIRED.appData),
    resources: need(REQUIRED.resources),
    pgPassword: need(REQUIRED.pgPassword),
    serverToken: need(REQUIRED.serverToken),
    vaultKey: need(REQUIRED.vaultKey),
    apiKey: env.ANTHROPIC_API_KEY === "" ? undefined : env.ANTHROPIC_API_KEY,
    version: env.SUUP_APP_VERSION ?? "dev",
    dockerPath: env.SUUP_DOCKER_PATH ?? "docker",
    sandbox: env.SUUP_SANDBOX === "local" ? "local" : "auto",
  };
}

export interface Sidecar {
  /** Resolves with the exit code when everything has stopped. */
  done: Promise<number>;
  /** Asks for a soft stop; a second call aborts the runs in progress. */
  stop(): void;
}

async function waitHealthy(url: string, giveUp: Promise<unknown>): Promise<boolean> {
  let abandoned = false;
  void giveUp.then(() => {
    abandoned = true;
  });
  for (let i = 0; i < 240 && !abandoned; i++) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * The sidecar: the app's own PostgreSQL, its migrations, then the Suup server with its worker in
 * this process (the CLI's `server --with-worker`, so there is one way to run them). Progress goes to
 * `emit`, the details to the log files in `<appData>/logs`.
 */
export function startSidecar(env: SidecarEnv, emit: (event: SidecarEvent) => void): Sidecar {
  const logger = createLogger(
    join(env.appData, "logs"),
    scrubber([env.pgPassword, env.serverToken, env.vaultKey, env.apiKey]),
  );
  const interrupts = new Set<() => void>();
  let stopRequested = false;
  let currentStage: Stage | null = null;
  const stage = (next: Stage) => {
    currentStage = next;
    logger.line(`etapa: ${next}`);
    emit({ event: "stage", stage: next });
  };
  const stop = () => {
    logger.line(stopRequested ? "parada: de novo (aborta já)" : "parada pedida");
    stopRequested = true;
    for (const handler of [...interrupts]) handler();
  };

  const run = async (): Promise<number> => {
    mkdirSync(env.appData, { recursive: true });
    const postgresLog = join(env.appData, "logs", "postgres.log");
    rotateIfBig(postgresLog, 20 * 1024 * 1024);
    const pg0 = (port: number) =>
      new EmbeddedPostgres({
        home: join(env.resources, "postgres"),
        dataDir: join(env.appData, "postgres"),
        logFile: postgresLog,
        password: env.pgPassword,
        port,
        log: (text) => logger.line(text),
      });
    // A server left running by a crash is stopped before the ports are chosen again.
    await pg0(0).stop();
    const ports = await choosePorts(join(env.appData, "ports.json"));
    const pg = pg0(ports.postgres);

    stage("database");
    await pg.start();
    await pg.ensureDatabase();

    if (stopRequested) return 0;
    stage("migrations");
    const db = createDb(pg.url());
    try {
      const applied = await migrate(db, join(env.resources, "migrations"));
      logger.line(`migrações aplicadas: ${applied.length}`);
    } finally {
      await db.close();
    }

    if (stopRequested) return 0;
    stage("machine");
    const images: AppImages = {
      sandbox: `suup-sandbox:app-${env.version}`,
      connectors: `suup-connector-runner:app-${env.version}`,
      egress: `suup-egress:app-${env.version}`,
      reader: `suup-reader:app-${env.version}`,
    };
    const networkName = "suup-sandbox-net";
    const { isolation, egress } =
      env.sandbox === "local"
        ? {
            isolation: {
              mode: "local",
              reason: "docker_missing",
              detail: "pedido pelo ambiente",
            } as const,
            egress: null,
          }
        : await chooseIsolation({
            docker: env.dockerPath,
            images,
            networkName,
            contexts: {
              sandbox: join(env.resources, "docker", "sandbox"),
              connectors: join(env.resources, "docker", "connector-runner"),
              egress: join(env.resources, "docker", "egress"),
            },
            onBuild: () =>
              logger.line("preparando as imagens da máquina dos bots (só na primeira vez)"),
            log: (text) => logger.line(text),
          });
    logger.line(
      `máquina dos bots: ${isolation.mode}${isolation.reason === null ? "" : ` (${isolation.reason}: ${isolation.detail ?? ""})`}`,
    );
    if (isolation.mode === "docker" && !stopRequested) {
      // The web's images (docs/BUSCA.md), the same way: built or pulled once, on the first start.
      const failed = await prepareWebImages({
        docker: env.dockerPath,
        reader: { image: images.reader, context: join(env.resources, "docker", "reader") },
        searxng: SEARXNG_IMAGE,
        onBuild: () =>
          logger.line("preparando as imagens da busca e da leitura (só na primeira vez)"),
        log: (text) => logger.line(text),
      });
      for (const line of failed) logger.line(`web sem parte do Docker: ${line}`);
    }

    if (stopRequested) return 0;
    stage("server");
    const workspace = join(env.appData, "workspace");
    mkdirSync(workspace, { recursive: true });
    const configPath = join(env.appData, "suup.config.json");
    // The owner may replace whole sections (the models, the limits...) in `config.override.json`,
    // next to the generated file: each top-level key there replaces the generated one.
    const overridePath = join(env.appData, "config.override.json");
    const override: unknown = existsSync(overridePath)
      ? JSON.parse(readFileSync(overridePath, "utf8"))
      : {};
    if (typeof override !== "object" || override === null || Array.isArray(override)) {
      throw new Error("config.override.json precisa ser um objeto JSON");
    }
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...buildConfig({ isolation, egress, workspace, images, networkName, allowedOrigins: [] }),
          ...override,
        },
        null,
        2,
      ),
    );
    const io: CliIo = {
      stdout: { write: (chunk) => void logger.line(chunk) },
      stderr: { write: (chunk) => void logger.line(chunk) },
      stdin: Readable.from([]),
      env: {
        ...process.env,
        DATABASE_URL: pg.url(),
        SUUP_SERVER_TOKEN: env.serverToken,
        SUUP_VAULT_KEY: env.vaultKey,
        ...(env.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: env.apiKey }),
        SUUP_DOCKER_PATH: env.dockerPath,
      },
      cwd: env.appData,
      onInterrupt(handler) {
        interrupts.add(handler);
        if (stopRequested) queueMicrotask(handler);
        return () => interrupts.delete(handler);
      },
    };
    const url = `http://127.0.0.1:${ports.server}`;
    const served = cli(
      [
        "server",
        "--with-worker",
        "--config",
        configPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.server),
      ],
      io,
    );
    const exited = served.then((code) => code);
    const healthy = await waitHealthy(url, exited);
    if (healthy) emit({ event: "ready", url, isolation });
    const code = await exited;
    if (!healthy && !stopRequested) {
      throw new Error(`o servidor parou ao iniciar (código ${code}). Veja ${logger.dir}.`);
    }
    return code;
  };

  const done = (async () => {
    let code = 0;
    try {
      code = await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.line(`ERRO ${message}`);
      emit({ event: "error", stage: currentStage, message });
      code = 1;
    }
    try {
      const home = join(env.resources, "postgres");
      await new EmbeddedPostgres({
        home,
        dataDir: join(env.appData, "postgres"),
        logFile: join(env.appData, "logs", "postgres.log"),
        password: env.pgPassword,
        port: 0,
        log: (text) => logger.line(text),
      }).stop();
    } catch (error) {
      logger.line(`ERRO ao parar o PostgreSQL: ${String(error)}`);
      code = code === 0 ? 1 : code;
    }
    emit({ event: "stopped" });
    return code;
  })();
  return { done, stop };
}

/** The process entry: the environment in, JSON lines out, "stop" or the end of stdin to stop. */
export async function runFromProcess(): Promise<void> {
  const write = (event: SidecarEvent) => process.stdout.write(encodeEvent(event));
  let env: SidecarEnv;
  try {
    env = readEnv(process.env);
  } catch (error) {
    write({
      event: "error",
      stage: null,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(2);
  }
  const sidecar = startSidecar(env, write);
  // The app owns this pipe: "stop" asks for a soft stop, and if the app dies the pipe closes, which
  // is the same ask. Nothing keeps running (or keeps the database up) once the app is gone.
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "stop") sidecar.stop();
    }
  });
  process.stdin.on("end", () => sidecar.stop());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => sidecar.stop());
  process.exit(await sidecar.done);
}
