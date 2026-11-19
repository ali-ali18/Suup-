import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SuupClient } from "@suup/api";
import type { Worker } from "@suup/core";
import { createDb, type Db, migrate } from "@suup/db";
import { createRuntime, parseConfig, type Runtime, type RuntimeConfig } from "@suup/runtime";
import { createServer, generateToken, type SuupServer } from "@suup/server";

// A real Suup server in this process, for the browser to talk to: Postgres (one schema per file),
// the real runtime on the `scripted` provider and the `local` sandbox, a worker in a runtime of its
// own, and the built web app served from a tiny static server. Nothing is mocked.

export const DATABASE_URL = process.env.DATABASE_URL;
export const SKIP_REASON =
  "DATABASE_URL não definido: os testes de ponta a ponta precisam de um PostgreSQL (veja apps/desktop/README.md).";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const plan = (...steps: [string, string, string][]) => ({
  name: "plan",
  args: { steps: steps.map(([id, title, status]) => ({ id, title, status })) },
});
const shell = (command: string) => ({ name: "shell", args: { command } });
const finish = (summary: string) => ({ name: "finish", args: { summary, evidence: [] } });

/** The scripts of the scripted provider: each case is chosen by a word in the message. */
export const SCRIPTS = {
  roteiro: {
    cases: [
      {
        // A plan that ticks, a tool, an edit with a diff, and a conclusion. The pauses are long enough
        // to be seen by a slow browser.
        whenObjectiveContains: "CASE-FLOW",
        // Each state of the work stays on screen for a couple of seconds (the pause is BEFORE a step).
        agent: [
          s({
            text: "Vou planejar.",
            calls: [
              plan(
                ["s1", "Preparar o arquivo", "in_progress"],
                ["s2", "Conferir o resultado", "pending"],
              ),
            ],
            delayMs: 300,
          }),
          s({ calls: [shell("echo feito > ola.txt")], delayMs: 2500 }),
          s({
            calls: [
              {
                name: "edit_file",
                args: { path: "ola.txt", old_string: "feito", new_string: "tudo certo" },
              },
            ],
            delayMs: 2500,
          }),
          s({
            calls: [
              plan(
                ["s1", "Preparar o arquivo", "done"],
                ["s2", "Conferir o resultado", "in_progress"],
              ),
            ],
            delayMs: 2500,
          }),
          s({
            calls: [
              plan(["s1", "Preparar o arquivo", "done"], ["s2", "Conferir o resultado", "done"]),
            ],
            delayMs: 2500,
          }),
          s({ calls: [finish("Criei o arquivo ola.txt e conferi o conteúdo.")], delayMs: 200 }),
        ],
      },
      {
        whenObjectiveContains: "CASE-OPTIONS",
        agent: [
          s({
            calls: [
              {
                name: "escalate",
                args: {
                  question: "Qual cor você prefere?",
                  options: [
                    { label: "Azul", description: "A cor do mar" },
                    { label: "Verde", description: "A cor da mata" },
                  ],
                },
              },
            ],
          }),
          s({ text: "Anotei a sua escolha e terminei." }),
        ],
      },
      {
        // Three questions: one choice, several choices, one choice with "other".
        whenObjectiveContains: "CASE-QUIZ",
        agent: [
          s({
            calls: [
              {
                name: "escalate",
                args: {
                  questions: [
                    {
                      question: "Qual banco de dados?",
                      options: [{ label: "Postgres" }, { label: "SQLite" }],
                    },
                    {
                      question: "Quais extras você quer?",
                      options: [{ label: "Cache" }, { label: "Fila" }, { label: "Busca" }],
                      multiple: true,
                    },
                    {
                      question: "Posso começar agora?",
                      options: [{ label: "Sim" }, { label: "Não" }],
                      allowOther: true,
                    },
                  ],
                },
              },
            ],
          }),
          s({ text: "Anotei todas as respostas." }),
        ],
      },
      {
        // Several tool calls, one of them slow enough to see it run: cards, folding, the indicator.
        whenObjectiveContains: "CASE-ACTIONS",
        agent: [
          s({
            calls: [
              plan(
                ["s1", "Preparar o ambiente", "in_progress"],
                ["s2", "Conferir tudo", "pending"],
              ),
            ],
            delayMs: 200,
          }),
          s({ calls: [shell("sleep 3; echo primeiro")], delayMs: 2500 }),
          s({ calls: [shell("echo segundo")], delayMs: 600 }),
          s({ calls: [shell("echo terceiro")], delayMs: 600 }),
          s({ calls: [shell("echo quarto")], delayMs: 600 }),
          s({ calls: [shell("sleep 3; echo quinto")], delayMs: 600 }),
          s({
            calls: [plan(["s1", "Preparar o ambiente", "done"], ["s2", "Conferir tudo", "done"])],
            delayMs: 300,
          }),
          s({ calls: [finish("Terminei as cinco ações.")], delayMs: 200 }),
        ],
      },
      {
        whenObjectiveContains: "CASE-TALL",
        agent: [
          s({
            text: Array.from({ length: 90 }, (_, i) => `Linha ${i + 1} da resposta longa.`).join(
              "\n\n",
            ),
          }),
        ],
      },
      {
        // Slow first turn: a second message arrives while the bot works.
        whenObjectiveContains: "CASE-BUSY",
        agent: [
          s({ text: "Trabalhando.", calls: [shell("sleep 6; echo ocupado")], delayMs: 1000 }),
          s({ text: "Li a sua segunda mensagem e terminei." }),
        ],
      },
      {
        // Many slow turns: time to pause, resume, reload and restart the server in the middle.
        whenObjectiveContains: "CASE-LONG",
        agent: [1, 2, 3, 4, 5, 6, 7, 8]
          .map((n) => s({ calls: [shell(`echo passo ${n}`)], delayMs: 1200 }))
          .concat([s({ text: "Terminei os oito passos." }) as never]),
      },
      {
        whenObjectiveContains: "CASE-MD",
        agent: [
          s({
            text: "Resumo:\n\n- primeiro **item**\n- segundo com `código`\n\nVeja [a documentação](https://example.com/docs) e <script>alert(1)</script> aqui.",
          }),
        ],
      },
      {
        whenObjectiveContains: "CASE-FAIL",
        agent: [
          s({
            error: {
              kind: "invalid_request",
              message: "o provedor recusou o pedido",
              retryable: false,
            },
          }),
        ],
      },
      {
        whenObjectiveContains: "DRAFT-ME",
        agent: [
          s({
            calls: [
              {
                name: "propose_bot",
                args: {
                  name: "Pepê (sugestão)",
                  description: "Ajuda a estudar inglês com paciência.",
                  personality:
                    "Você é um professor de inglês paciente que corrige com gentileza e explica o motivo de cada correção.",
                },
              },
            ],
          }),
        ],
      },
      { whenObjectiveContains: "OI-SIMPLES", agent: [s({ text: "Olá! Como posso ajudar?" })] },
    ],
  },
};

export interface World {
  /** The web app, served as the browser sees it. */
  appUrl: string;
  /** The Suup server (what the app connects to). */
  serverUrl: string;
  token: string;
  api: SuupClient;
  db: Db;
  schema: string;
  /** Stops the server (the worker keeps working), then starts it again on the same address. */
  restartServer(options?: { downMs?: number }): Promise<void>;
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function serveDist(): Promise<{ server: Server; origin: string }> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error(
      "O app ainda não foi compilado: rode `pnpm --filter @suup/desktop build` antes dos testes de ponta a ponta.",
    );
  }
  const server = createHttpServer((req, res) => {
    void (async () => {
      const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
      const file = join(DIST, path === "/" || path.includes("..") ? "index.html" : path);
      try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        // single-page app: unknown paths get the page
        res.writeHead(200, { "Content-Type": MIME[".html"] as string });
        res.end(await readFile(join(DIST, "index.html")));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function startWorld(
  options: { scripts?: Record<string, unknown> } = {},
): Promise<World> {
  if (DATABASE_URL === undefined) throw new Error(SKIP_REASON);
  const schema = `e2e_${randomBytes(6).toString("hex")}`;
  const cleanups: (() => Promise<void>)[] = [];
  const admin = createDb(DATABASE_URL, { max: 1 });
  await admin.sql.unsafe(`create schema ${schema}`);
  cleanups.push(async () => {
    await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.close();
  });
  const url = new URL(DATABASE_URL);
  url.searchParams.set("search_path", schema);
  const env = { DATABASE_URL: url.toString() };
  const db = createDb(DATABASE_URL, { schema });
  cleanups.unshift(() => db.close());
  await migrate(db);

  const dir = await mkdtemp(join(tmpdir(), "suup-desktop-e2e-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(options.scripts ?? SCRIPTS)) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify(content, null, 2));
  }
  await writeFile(
    join(dir, "outro.json"),
    JSON.stringify({ cases: [{ whenObjectiveContains: "X", agent: [{ text: "x", usage }] }] }),
  );
  const config: RuntimeConfig = parseConfig({
    providers: [
      { id: "roteiro", kind: "scripted", scriptPath: "roteiro.json" },
      { id: "outro", kind: "scripted", scriptPath: "outro.json" },
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
    ],
    sandbox: { kind: "local", root: "workspace" },
    approvals: { levels: { shell: "write_reversible" } },
    worker: { concurrency: 4, leaseRenewMs: 1000, staleAfterMs: 8000, controlPollMs: 100 },
    defaults: { maxTurns: 30 },
  });
  const runtimeOptions = { env, baseDir: dir };

  const web = await serveDist();
  cleanups.unshift(() => new Promise<void>((resolve) => web.server.close(() => resolve())));
  const token = generateToken();

  let serverRuntime: Runtime | undefined;
  let server: SuupServer | undefined;
  let port = 0;
  const startServer = async (bootstrap: boolean) => {
    serverRuntime = createRuntime(config, runtimeOptions);
    server = createServer(serverRuntime, {
      token,
      host: "127.0.0.1",
      port,
      shutdownGraceMs: 300,
      allowedOrigins: [web.origin],
      bootstrap,
    });
    const address = await server.listen();
    port = Number(new URL(address).port);
    return address;
  };
  const stopServer = async () => {
    await server?.close();
    await serverRuntime?.close();
    server = undefined;
    serverRuntime = undefined;
  };
  const serverUrl = await startServer(true);
  cleanups.unshift(stopServer);

  const workerRuntime = createRuntime(config, runtimeOptions);
  cleanups.unshift(() => workerRuntime.close());
  const worker: Worker = workerRuntime.createWorker({
    concurrency: 4,
    idleBackoff: { minMs: 15, maxMs: 80 },
    onError: (error, context) => console.error(`worker: ${context}:`, error),
  });
  worker.start();
  cleanups.unshift(() => worker.stop({ graceMs: 2000 }));

  return {
    appUrl: web.origin,
    serverUrl,
    token,
    api: createClient({ baseUrl: serverUrl, token }),
    db,
    schema,
    stopServer,
    startServer: async () => void (await startServer(false)),
    async restartServer({ downMs = 0 } = {}) {
      await stopServer();
      if (downMs > 0) await new Promise((resolve) => setTimeout(resolve, downMs));
      await startServer(false);
    },
    async stop() {
      for (const cleanup of cleanups) {
        try {
          await cleanup();
        } catch (error) {
          console.error("cleanup failed:", error);
        }
      }
    },
  };
}
