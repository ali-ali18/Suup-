import type { RunEnd } from "@suup/core";
import { DEFAULT_SERVER } from "@suup/runtime";
import {
  assertToken,
  createServer,
  generateToken,
  type Logger,
  ServerConfigError,
  TAURI_ORIGINS,
} from "@suup/server";
import { flag, posInt, str } from "../args.js";
import { type CommandSpec, warnIfLocalSandbox } from "../context.js";
import { CommandError, EXIT_OK } from "../errors.js";
import { formatDuration, statusPt } from "../format.js";

const SOFT_STOP_GRACE_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function describeEnd(end: RunEnd): string {
  const id = end.runId.slice(0, 8);
  switch (end.outcome) {
    case "settled":
      return `worker: execução ${id}: ${statusPt(end.status)} em ${formatDuration(end.durationMs)}`;
    case "released":
      return `worker: execução ${id}: devolvida à fila (${end.reason})`;
    case "failed":
      return `worker: execução ${id}: falhou fora do caminho do modelo e das ferramentas (harness): ${end.error instanceof Error ? end.error.message : String(end.error)}`;
    case "lease_lost":
      return `worker: execução ${id}: outro worker assumiu a posse`;
  }
}

export const serverCommand: CommandSpec = {
  name: "server",
  summary:
    "Sobe o servidor HTTP (API e tempo real) que o app usa; com --with-worker, também um worker",
  options: {
    host: {
      type: "string",
      value: "endereço",
      help: `Interface em que escutar (padrão: server.host da configuração, ou ${DEFAULT_SERVER.host}, só este computador)`,
    },
    port: {
      type: "string",
      value: "N",
      help: `Porta (padrão: server.port da configuração, ou ${DEFAULT_SERVER.port})`,
    },
    "with-worker": {
      type: "boolean",
      help: "Embute um worker no mesmo processo (uma VPS pequena); sem isto, rode suup worker à parte",
    },
    concurrency: {
      type: "string",
      value: "N",
      help: "Com --with-worker: execuções ao mesmo tempo (padrão: da configuração, ou 4)",
    },
    "generate-token": {
      type: "boolean",
      help: "Só imprime um token novo (256 bits aleatórios) e sai",
    },
  },
  positionals: { names: [] },
  notes: [
    `O token vem SÓ da variável de ambiente indicada por server.tokenEnv (padrão ${DEFAULT_SERVER.tokenEnv}); precisa ter pelo menos 32 caracteres.`,
    "Gere um: suup server --generate-token. O servidor não sobe sem token.",
    "Por padrão escuta só em 127.0.0.1. Para escutar em outra interface informe --host (ou server.host) e",
    "ponha um proxy com TLS na frente: o servidor fala HTTP puro e o token trafega em texto (docs/IMPLANTACAO.md).",
    `Origens do app de desktop (Tauri) para server.allowedOrigins: ${TAURI_ORIGINS.join(", ")}.`,
    "Documentação dos endpoints: docs/API.md.",
  ],
  async run(ctx) {
    if (flag(ctx.args, "generate-token")) {
      if (ctx.json) ctx.out.data({ token: generateToken() });
      else ctx.io.stdout.write(`${generateToken()}\n`);
      return EXIT_OK;
    }

    const { config } = ctx.config();
    const settings = config.server ?? {};
    const host = str(ctx.args, "host") ?? settings.host ?? DEFAULT_SERVER.host;
    const port = posInt(ctx.args, "port", "server") ?? settings.port ?? DEFAULT_SERVER.port;
    const tokenEnv = settings.tokenEnv ?? DEFAULT_SERVER.tokenEnv;
    const token = ctx.io.env[tokenEnv];
    try {
      assertToken(token, `a variável de ambiente ${tokenEnv}`);
    } catch (error) {
      if (error instanceof ServerConfigError) throw new CommandError(error.message);
      throw error;
    }

    const runtime = ctx.runtime();
    warnIfLocalSandbox(ctx);
    const stamp = () => new Date().toISOString();
    const logger: Logger = {
      info: (message) => ctx.out.line(`${stamp()} ${message}`),
      warn: (message) => ctx.out.line(`${stamp()} AVISO ${message}`),
      error: (message, error) =>
        ctx.out.err(
          `${stamp()} ERRO ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`,
        ),
    };
    const server = createServer(runtime, {
      token,
      host,
      port,
      allowedOrigins: settings.allowedOrigins ?? [],
      ...(settings.maxStreams === undefined ? {} : { maxStreams: settings.maxStreams }),
      ...(settings.maxBodyBytes === undefined ? {} : { maxBodyBytes: settings.maxBodyBytes }),
      ...(settings.eventRetentionMinutes === undefined
        ? {}
        : { eventRetentionMinutes: settings.eventRetentionMinutes }),
      // An API-only server in a Docker deployment has no access to the bot machine on purpose.
      checkSandbox: flag(ctx.args, "with-worker") || config.sandbox.kind === "local",
      logger,
    });
    let url: string;
    try {
      url = await server.listen();
    } catch (error) {
      if (error instanceof ServerConfigError) throw new CommandError(error.message);
      const code = (error as { code?: string }).code;
      if (code === "EADDRINUSE") {
        throw new CommandError(`A porta ${port} de ${host} já está em uso.`);
      }
      throw error;
    }

    const concurrency = posInt(ctx.args, "concurrency", "server");
    const worker = flag(ctx.args, "with-worker")
      ? runtime.createWorker({
          ...(concurrency === undefined ? {} : { concurrency }),
          onRunEnd: (end) => logger.info(describeEnd(end)),
          onError: (error, context) => logger.error(`worker: ${context}`, error),
        })
      : undefined;
    worker?.start();

    ctx.out.line(
      `Servidor no ar em ${url}${worker === undefined ? "" : ` (com o worker ${worker.workerId})`}`,
    );
    if (!LOOPBACK.has(host)) {
      ctx.out.warn(
        `escutando em ${host}, não só neste computador, e o servidor fala HTTP puro: o token e as conversas trafegam sem criptografia. Ponha um proxy com TLS na frente e feche a porta para o resto da rede (docs/IMPLANTACAO.md).`,
      );
    }
    if (worker === undefined) {
      ctx.out.line("Sem worker neste processo: rode `suup worker` para as execuções andarem.");
    }

    await new Promise<void>((resolve) => {
      let presses = 0;
      const unsubscribe = ctx.io.onInterrupt(() => {
        presses += 1;
        if (presses === 1) {
          ctx.out.line(
            "Desligando: fechando as conexões e levando as execuções até o próximo ponto seguro (Ctrl+C de novo aborta já).",
          );
          void (async () => {
            await server.close();
            await worker?.stop({ graceMs: SOFT_STOP_GRACE_MS });
            unsubscribe();
            resolve();
          })();
        } else {
          void worker?.abortNow();
        }
      });
    });
    ctx.out.line("Servidor parado.");
    return EXIT_OK;
  },
};
