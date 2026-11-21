import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SuupClient } from "@suup/api";
import type { Tool, Worker } from "@suup/core";
import { createDb, type Db, migrate } from "@suup/db";
import {
  createRuntime,
  generateKeyText,
  parseConfig,
  type Runtime,
  type RuntimeConfig,
} from "@suup/runtime";
import { createServer, generateToken, type SuupServer } from "@suup/server";

// A real Suup server in this process, for the browser to talk to: Postgres (one schema per file),
// the real runtime on the `scripted` provider and the `local` sandbox, a worker in a runtime of its
// own, and the built web app served from a tiny static server. Nothing is mocked.

export const DATABASE_URL = process.env.DATABASE_URL;
export const SKIP_REASON =
  "DATABASE_URL não definido: os testes de ponta a ponta precisam de um PostgreSQL (veja apps/desktop/README.md).";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

/**
 * The in-repo fake MCP server (`packages/connectors/src/testing/fake-server.ts`), as the command a
 * connector runs: Node itself, from the sources (type stripping), the same path a real server takes.
 */
export function fakeMcpCommand(): { command: string; args: string[] } {
  const file = fileURLToPath(
    new URL("../../../packages/connectors/src/testing/fake-server.ts", import.meta.url),
  );
  return { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", file] };
}

/** The name of the environment variable that holds the vault's master key in the test servers. */
export const VAULT_KEY_ENV = "SUUP_E2E_VAULT_KEY";

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const plan = (...steps: [string, string, string][]) => ({
  name: "plan",
  args: { steps: steps.map(([id, title, status]) => ({ id, title, status })) },
});
const shell = (command: string) => ({ name: "shell", args: { command } });
const writeCall = (path: string, content: string) => ({
  name: "write_file",
  args: { path, content },
});
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
      // ---- Phase 3: approvals, the vault and connectors. `write_file` asks (see `approvals.levels`).
      {
        whenObjectiveContains: "CASE-APPROVE",
        agent: [
          s({
            text: "Vou gravar o arquivo.",
            calls: [writeCall("aprovado.txt", "conteúdo aprovado\nsegunda linha")],
          }),
          s({ text: "Escrevi o arquivo aprovado." }),
        ],
      },
      {
        // Approved after the card waited for hours: the first call is held back, the bot asks again.
        whenObjectiveContains: "CASE-STALE",
        agent: [
          s({
            text: "Vou gravar o arquivo.",
            calls: [writeCall("tardio.txt", "conteúdo tardio")],
          }),
          s({
            text: "Retomando a tarefa antiga: ainda faz sentido.",
            calls: [writeCall("tardio.txt", "conteúdo tardio")],
          }),
          s({ text: "Escrevi o arquivo tardio." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-DENY",
        agent: [
          s({ calls: [writeCall("negado.txt", "isto não deve ser escrito")] }),
          s({ text: "Entendi, não escrevi o arquivo." }),
        ],
      },
      {
        // The second message of that conversation (matched before CASE-ALWAYS, which the whole
        // conversation still contains). The history counts as one earlier answer of the bot, so the
        // call is the second step of the script, and the run ends on the third.
        whenObjectiveContains: "CASE-AGAIN",
        agent: [
          s({ text: "(esta etapa pertence ao primeiro pedido)" }),
          s({ calls: [writeCall("sempre.txt", "pode sempre")] }),
          s({ text: "Segundo arquivo escrito, sem perguntar." }),
        ],
      },
      {
        // The same call twice, in two messages of the conversation: "always allow" on the first one
        // must make the second run without a card (see CASE-AGAIN).
        whenObjectiveContains: "CASE-ALWAYS",
        agent: [
          s({ calls: [writeCall("sempre.txt", "pode sempre")] }),
          s({ text: "Primeiro arquivo escrito." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-BIGARGS",
        agent: [
          s({
            calls: [
              writeCall(
                "longo.txt",
                Array.from({ length: 30 }, (_, i) => `linha ${i + 1} do arquivo longo`).join("\n"),
              ),
            ],
          }),
          s({ text: "Arquivo longo escrito." }),
        ],
      },
      {
        // A rule of the user forbids this path: no card, the bot is told and goes on.
        whenObjectiveContains: "CASE-RULEDENY",
        agent: [
          s({ calls: [writeCall("proibido/segredo.txt", "não")] }),
          s({ text: "A regra não deixou eu escrever lá." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-SECRET-NO",
        agent: [
          s({
            calls: [
              {
                name: "request_secret",
                args: { name: "E2E_RECUSADO", reason: "para o teste de recusa" },
              },
            ],
          }),
          s({ text: "Sem o segredo, sigo de outro jeito." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-SECRET",
        agent: [
          s({
            calls: [
              {
                name: "request_secret",
                args: { name: "E2E_TOKEN", reason: "para acessar a API de teste" },
              },
            ],
          }),
          s({ calls: [shell("echo token-recebido={{secret:E2E_TOKEN}}")] }),
          s({ text: "Recebi o segredo e usei." }),
        ],
      },
      {
        // A tool of the connector `fake` (granted to the bot in the test): it writes, so it asks.
        whenObjectiveContains: "CASE-CONNECTOR",
        agent: [
          s({
            calls: [
              {
                name: "conn_fake__write_thing",
                args: { name: "coisa", body: "corpo enviado pelo conector" },
              },
            ],
          }),
          s({ text: "Criei a coisa no conector." }),
        ],
      },
      {
        // The connector tool `send_email` is a normal write until the USER marks it as a message.
        whenObjectiveContains: "CASE-EMAIL-NORMAL",
        agent: [
          s({
            calls: [
              {
                name: "conn_fake__send_email",
                args: { to: "ana@exemplo.com", subject: "Plano", body: "Segue o plano." },
              },
            ],
          }),
          s({ text: "E-mail normal enviado." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-EMAIL-MARCADO",
        agent: [
          s({
            calls: [
              {
                name: "conn_fake__send_email",
                args: { to: "ana@exemplo.com", subject: "Olá", body: "Tudo bem?" },
              },
            ],
          }),
          s({ text: "E-mail enviado." }),
        ],
      },
      {
        // Per-tool grants: `echo` was ticked for the bot, `lying_read` was not (the bot is not
        // offered it, so the call fails as an unknown tool and nothing reaches the server).
        whenObjectiveContains: "CASE-GRANTS",
        agent: [
          s({ calls: [{ name: "conn_fake__echo", args: { text: "oi do bot" } }] }),
          s({ calls: [{ name: "conn_fake__lying_read", args: { name: "escondida" } }] }),
          s({ text: "Terminei: usei uma e não consegui a outra." }),
        ],
      },
      {
        // Tool search (meta mode): the bot looks the tools up, then calls one through `use_tool`.
        whenObjectiveContains: "CASE-META",
        agent: [
          s({ calls: [{ name: "search_tools", args: { connector: "fake", words: "ledger" } }] }),
          s({
            calls: [
              {
                name: "use_tool",
                args: { tool: "conn_fake__gen_3", arguments: { id: "7" } },
              },
            ],
          }),
          s({ text: "Consultei o registro 7." }),
        ],
      },
      {
        // The bot asks to reach one more host: a normal card, valid for this run only.
        whenObjectiveContains: "CASE-NETWORK",
        agent: [
          s({
            calls: [
              {
                name: "request_network_access",
                args: { host: "api.novo.com", reason: "preciso baixar o relatório do mês" },
              },
            ],
          }),
          s({ text: "Tentei liberar o host." }),
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
  options: {
    scripts?: Record<string, unknown>;
    /** A vault with its master key (default). `false`: a server with no vault configured. */
    vault?: boolean;
    /** The tool search settings (default: off, so scripts call connector tools by name). */
    toolSearch?: { minTools: number; minDefinitionTokens: number };
    /**
     * Registers `request_network_access` in the runtimes, as the isolated (docker) machine has it.
     * The e2e has no Docker: the card is real, and the tool says it has no proxy to act on.
     */
    networkTool?: boolean;
    /**
     * A model for the Auto-review reviewer (the model id of the configuration), so the mode really
     * has a reviewer. Its answers come from the `autoReview` section of the scripts.
     */
    autoReviewModel?: string;
    /** How often the worker looks for runs whose scheduled return is due (default: its own, 5 s). */
    wakeEveryMs?: number;
  } = {},
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
  const vault = options.vault ?? true;
  const env: Record<string, string> = {
    DATABASE_URL: url.toString(),
    ...(vault ? { [VAULT_KEY_ENV]: generateKeyText() } : {}),
  };
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
    // The shell does not ask (most scripts use it); writing a file does, which is what the approval
    // tests call. Phase 3 also has the vault, and connectors need nothing here.
    approvals: {
      levels: { shell: "write_reversible", write_file: "external_irreversible" },
      ...(options.autoReviewModel === undefined
        ? {}
        : { autoReview: { model: options.autoReviewModel } }),
    },
    ...(vault ? { vault: { keyEnv: VAULT_KEY_ENV } } : {}),
    // The scripts call the fake connector server's tools directly (it has 17): the tool search,
    // which would defer them, has its own tests (docs/CONECTORES.md).
    toolSearch: options.toolSearch ?? { minTools: 1000, minDefinitionTokens: 10_000_000 },
    worker: { concurrency: 4, leaseRenewMs: 1000, staleAfterMs: 8000, controlPollMs: 100 },
    defaults: { maxTurns: 30 },
  });
  const runtimeOptions = { env, baseDir: dir };
  const withNetworkTool = async (runtime: Runtime): Promise<Runtime> => {
    if (options.networkTool !== true) return runtime;
    // From the sources of the package (the desktop app does not depend on it).
    const path = fileURLToPath(new URL("../../../packages/tools/dist/index.js", import.meta.url));
    const tools = (await import(path)) as { networkTools: readonly Tool<unknown>[] };
    for (const tool of tools.networkTools) runtime.tools.register(tool);
    return runtime;
  };

  const web = await serveDist();
  cleanups.unshift(() => new Promise<void>((resolve) => web.server.close(() => resolve())));
  const token = generateToken();

  let serverRuntime: Runtime | undefined;
  let server: SuupServer | undefined;
  let port = 0;
  const startServer = async (bootstrap: boolean) => {
    serverRuntime = await withNetworkTool(createRuntime(config, runtimeOptions));
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

  const workerRuntime = await withNetworkTool(createRuntime(config, runtimeOptions));
  cleanups.unshift(() => workerRuntime.close());
  const worker: Worker = workerRuntime.createWorker({
    concurrency: 4,
    idleBackoff: { minMs: 15, maxMs: 80 },
    ...(options.wakeEveryMs === undefined ? {} : { wakeEveryMs: options.wakeEveryMs }),
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
