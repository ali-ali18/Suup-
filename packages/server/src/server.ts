import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { streamQuerySchema } from "@suup/api";
import { migrationStatus, pruneChangeLog } from "@suup/db";
import { DEFAULT_SERVER, ensureDefaultBot, type Runtime, reconcileRunEffects } from "@suup/runtime";
import type { z } from "zod";
import { assertToken, isAuthorized } from "./auth.js";
import { checkOrigin, corsHeaders } from "./cors.js";
import { describeZod, HttpError, ServerConfigError, toHttpError } from "./errors.js";
import {
  acceptRequestId,
  type Ctx,
  compileRoute,
  isUuid,
  type Matcher,
  matchRoute,
  newRequestId,
  type Reply,
  type Route,
  readJsonBody,
  writerFor,
} from "./http.js";
import { approvalRoutes } from "./routes/approvals.js";
import { botRoutes } from "./routes/bots.js";
import { connectorRoutes } from "./routes/connectors.js";
import { conversationRoutes } from "./routes/conversations.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { memoryRoutes } from "./routes/memories.js";
import { metaRoutes } from "./routes/meta.js";
import { networkRoutes } from "./routes/network.js";
import { runRoutes } from "./routes/runs.js";
import { vaultRoutes } from "./routes/vault.js";
import { createDbSource, createPgNotifier } from "./stream/db-source.js";
import {
  type Clock,
  type HubOptions,
  type Sink,
  StreamHub,
  StreamLimitError,
} from "./stream/hub.js";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

export interface ServerOptions {
  /** The bearer token. At least 32 characters. */
  token: string;
  /** Interface to listen on. Default `127.0.0.1`: this computer only. */
  host?: string;
  /** Default 8787. 0 picks a free port (tests). */
  port?: number;
  /** Browser origins allowed to call the API. Default: none. */
  allowedOrigins?: readonly string[];
  maxStreams?: number;
  maxBodyBytes?: number;
  /** How long a request may take to arrive and, for most routes, to answer. Default 30 s. */
  requestTimeoutMs?: number;
  /** How long the change log is kept: the window `Last-Event-ID` can resume from. Default 6 h. */
  eventRetentionMinutes?: number;
  /**
   * What the server does at start before it listens: settle the effects of runs that ended while
   * no worker looked (`reconcileRunEffects`) and make sure a main bot exists (`ensureDefaultBot`,
   * with the first model of the configuration). Default `true`.
   */
  bootstrap?: boolean;
  /**
   * Whether `listen` first checks the database (migrations applied), bootstraps, starts the
   * realtime hub and the pruning of the change log. Default `true`. `false` only binds the port:
   * for tests of the HTTP layer (auth, CORS, limits) that never reach the database.
   */
  startupChecks?: boolean;
  /**
   * Whether `GET /v1/doctor` checks the bot machine from this process. Default `true`. An API-only
   * server in a deployment (no Docker socket, by design) sets `false`: the worker is what uses it.
   */
  checkSandbox?: boolean;
  logger?: Logger;
  /** Grace for open requests at shutdown before the connections are cut. Default 5 s. */
  shutdownGraceMs?: number;
  /** Tests: clock, intervals and limits of the realtime hub. */
  hub?: Partial<
    Pick<HubOptions<never>, "keepAliveMs" | "pollMs" | "maxPendingBytes" | "maxReplay" | "batch">
  > & {
    clock?: Clock;
  };
}

export interface SuupServer {
  /** Checks the database, bootstraps, starts the realtime hub and listens. Resolves to the URL. */
  listen(): Promise<string>;
  /** Ends the streams, stops accepting, lets open requests finish (then cuts them). Idempotent. */
  close(): Promise<void>;
  /** `http://host:port` once `listen` has resolved. */
  readonly url: string;
  readonly hub: StreamHub;
}

const PRUNE_EVERY_MS = 10 * 60_000;
const KEEP_CHANGES = 500_000;

function fail(message: string): never {
  throw new ServerConfigError(message);
}

/**
 * The HTTP API and the realtime stream a client talks to, over the runtime. Node's `http` only:
 * no framework. It does not run loops: runs are worked on by workers (`suup worker`, or the one
 * `suup server --with-worker` embeds), and what the server does to a run (pause, interrupt,
 * cancel, resume) goes through the database, where the worker reads it.
 */
export function createServer(runtime: Runtime, options: ServerOptions): SuupServer {
  assertToken(options.token, "a variável de ambiente do token (server.tokenEnv)");
  const host = options.host ?? DEFAULT_SERVER.host;
  const port = options.port ?? DEFAULT_SERVER.port;
  // No log line carries a known secret value, whatever put it in the message or the error.
  const sink = options.logger ?? silent;
  const scrub = (text: string): string => runtime.redactor.redact(text);
  const log: Logger = {
    info: (message) => sink.info(scrub(message)),
    warn: (message) => sink.warn(scrub(message)),
    error: (message, error) => sink.error(scrub(message), scrubError(error, scrub)),
  };
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_SERVER.maxBodyBytes;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const retentionMs =
    (options.eventRetentionMinutes ?? DEFAULT_SERVER.eventRetentionMinutes) * 60_000;
  const graceMs = options.shutdownGraceMs ?? 5_000;

  const matchers: Matcher[] = [
    ...botRoutes,
    ...conversationRoutes,
    ...runRoutes,
    ...diagnosticsRoutes,
    ...memoryRoutes,
    ...approvalRoutes,
    ...networkRoutes,
    ...vaultRoutes,
    ...connectorRoutes,
    ...metaRoutes,
  ].map(compileRoute);

  const database = runtime.db;
  const hub = new StreamHub({
    source: createDbSource(database, (value) => runtime.redactJson(value)),
    notifier: createPgNotifier(database),
    maxStreams: options.maxStreams ?? DEFAULT_SERVER.maxStreams,
    onError: (error, context) => log.error(`stream: ${context}`, error),
    onDrop: (reason) => log.warn(`stream: um cliente foi desconectado (${reason})`),
    ...options.hub,
  });

  let closing = false;
  let listening: string | undefined;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  const sockets = new Set<Socket>();
  const inflight = new Set<Promise<void>>();

  const server: Server = createHttpServer((req, res) => {
    const done = handle(req, res).catch((error: unknown) => {
      log.error("falha ao tratar uma requisição", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });
  // Ours (`request_timeout`, in our error shape) fires first; Node's is only the backstop.
  server.requestTimeout = requestTimeoutMs + 10_000;
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = acceptRequestId(req.headers["x-request-id"]) ?? newRequestId();
    const method = req.method ?? "GET";
    let path = "/";
    let status = 0;
    const origin = checkOrigin(req.headers.origin, allowedOrigins);
    const base: Record<string, string> = {
      "X-Request-Id": requestId,
      ...(origin.kind === "allowed" ? corsHeaders(origin.origin, false) : {}),
    };
    const out = writerFor(res, base, () => closing);
    res.on("finish", () => {
      status = res.statusCode;
    });
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://suup.local");
      } catch {
        throw new HttpError("invalid_request", "Endereço da requisição inválido.");
      }
      path = url.pathname;

      if (closing) throw new HttpError("unavailable", "O servidor está desligando.");
      if (origin.kind === "denied") {
        throw new HttpError(
          "origin_not_allowed",
          `A origem ${origin.origin} não tem permissão para usar este servidor.`,
        );
      }
      if (method === "OPTIONS") {
        if (origin.kind === "allowed") {
          out.json(204, null, corsHeaders(origin.origin, true));
          return;
        }
        throw new HttpError("not_found", "Rota não encontrada.");
      }
      // The one route that needs no token, and says nothing but "ok".
      if (path === "/health") {
        if (method !== "GET" && method !== "HEAD") {
          throw new HttpError("method_not_allowed", "Use GET.");
        }
        out.json(200, { status: "ok" });
        return;
      }
      if (!path.startsWith("/v1/")) throw new HttpError("not_found", "Rota não encontrada.");
      // Everything under /v1 is behind the token, unknown routes included: a stranger learns
      // nothing about which routes exist.
      if (!isAuthorized(req.headers.authorization, options.token)) {
        throw new HttpError(
          "unauthorized",
          "Token ausente ou inválido (envie Authorization: Bearer <token>).",
        );
      }

      if (path === "/v1/stream") {
        if (method !== "GET") throw new HttpError("method_not_allowed", "Use GET.");
        await openStream(req, res, url, base);
        return;
      }

      const found = findRoute(path, method);
      const route = found.route;
      const rawBody =
        method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
          ? await readJsonBody(req, { maxBytes: maxBodyBytes, timeoutMs: requestTimeoutMs })
          : undefined;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const ctx = makeCtx({
        req,
        url,
        params: found.params,
        rawBody,
        requestId,
        signal: abort.signal,
        method,
        path,
      });
      const timeoutMs = route.timeoutMs ?? requestTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(
            new HttpError("request_timeout", "A requisição demorou demais para ser respondida."),
          );
        }, timeoutMs);
      });
      let reply: Reply;
      try {
        reply = await Promise.race([route.handler(ctx), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      // Nothing leaves the server holding a known secret value, whatever put it there.
      out.json(reply.status ?? 200, await runtime.redactJson(reply.body));
    } catch (caught) {
      const error = toHttpError(caught);
      if (error.code === "internal_error" || error.code === "unavailable") {
        log.error(`${method} ${path}: ${error.message}`, error.cause ?? caught);
      }
      // An unread body (too large, too slow) means the connection cannot be reused.
      out.error(error, error.code === "payload_too_large" || error.code === "request_timeout");
    } finally {
      const text = `${method} ${path} ${status === 0 ? res.statusCode : status} ${Date.now() - started}ms ${requestId}`;
      if (path !== "/health") log.info(text);
    }
  }

  function findRoute(
    path: string,
    method: string,
  ): { route: Route; params: Record<string, string> } {
    let pathMatched = false;
    for (const matcher of matchers) {
      const match = matchRoute(matcher, path);
      if (match === null) continue;
      pathMatched = true;
      if (matcher.route.method !== method) continue;
      const params: Record<string, string> = {};
      matcher.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i] ?? "");
      });
      return { route: matcher.route, params };
    }
    if (pathMatched) throw new HttpError("method_not_allowed", "Esta rota não aceita este método.");
    throw new HttpError("not_found", "Rota não encontrada.");
  }

  function makeCtx(input: {
    req: IncomingMessage;
    url: URL;
    params: Record<string, string>;
    rawBody: unknown;
    requestId: string;
    signal: AbortSignal;
    method: string;
    path: string;
  }): Ctx {
    const parse = <S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> => {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new HttpError(
          "invalid_request",
          `${where === "corpo" ? "" : "parâmetro "}${describeZod(result.error)}`,
          {
            cause: result.error,
          },
        );
      }
      return result.data;
    };
    return {
      runtime,
      method: input.method,
      path: input.path,
      params: input.params,
      requestId: input.requestId,
      doctorSandbox: options.checkSandbox !== false,
      signal: input.signal,
      req: input.req,
      query: (schema) => parse(schema, Object.fromEntries(input.url.searchParams), "consulta"),
      body: (schema) => parse(schema, input.rawBody ?? {}, "corpo"),
      uuid(name) {
        const value = input.params[name] ?? "";
        if (!isUuid(value)) throw new HttpError("not_found", "Recurso não encontrado.");
        return value.toLowerCase();
      },
    };
  }

  async function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    base: Record<string, string>,
  ): Promise<void> {
    const query = streamQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) throw new HttpError("invalid_request", describeZod(query.error));
    const header = req.headers["last-event-id"];
    let lastEventId = query.data.lastEventId;
    if (typeof header === "string" && header !== "") {
      if (!/^\d{1,15}$/.test(header)) {
        throw new HttpError("invalid_request", "Last-Event-ID precisa ser um número.");
      }
      lastEventId = Number(header);
    }
    const activeHub = hub;
    if (activeHub.size >= (options.maxStreams ?? DEFAULT_SERVER.maxStreams)) {
      throw new HttpError(
        "too_many_streams",
        `O servidor já atende ${options.maxStreams ?? DEFAULT_SERVER.maxStreams} streams ao mesmo tempo.`,
      );
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      ...base,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders();
    const sink: Sink = {
      write: (chunk) => (res.writableEnded ? false : res.write(chunk)),
      get pendingBytes() {
        return res.writableLength;
      },
      end: () => {
        if (!res.writableEnded) res.end();
      },
    };
    res.on("close", () => activeHub.disconnect(sink));
    try {
      await activeHub.connect({
        sink,
        runs: query.data.runs ?? [],
        ...(lastEventId === undefined ? {} : { lastEventId }),
      });
    } catch (error) {
      if (error instanceof StreamLimitError) {
        // Lost the race for the last slot after the headers went out: nothing else to say.
        res.end();
        return;
      }
      throw error;
    }
    // The request is over only when the client goes away or the hub ends it.
    await new Promise<void>((resolve) => res.once("close", resolve));
  }

  /** The checks and the background work that come before listening (see `startupChecks`). */
  async function startUp(): Promise<void> {
    const status = await migrationStatus(database);
    if (status.pending.length > 0) {
      fail(
        `O banco tem ${status.pending.length} migraç${status.pending.length === 1 ? "ão pendente" : "ões pendentes"} (${status.pending.join(", ")}). Rode: suup db migrate`,
      );
    }
    if (options.bootstrap !== false) {
      const settled = await reconcileRunEffects(database, {
        redact: (value) => runtime.redactJson(value),
      });
      if (settled.length > 0) {
        log.info(`${settled.length} execução(ões) que terminaram sem aviso foram acertadas.`);
      }
      const first = runtime.config.models[0];
      if (first !== undefined) {
        const { bot, created } = await ensureDefaultBot(runtime, { modelId: first.id });
        if (created) log.info(`Bot principal criado: ${bot.name} (${bot.id}).`);
      }
    }
    await hub.start();
    const prune = () =>
      void pruneChangeLog(database, { olderThanMs: retentionMs, keepLast: KEEP_CHANGES }).catch(
        (error: unknown) => log.error("não foi possível podar o diário de mudanças", error),
      );
    prune();
    pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
    pruneTimer.unref();
  }

  const handle_ = {
    async listen(): Promise<string> {
      if (listening !== undefined) return listening;
      if (options.startupChecks !== false) await startUp();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      listening = `http://${shown}:${address.port}`;
      return listening;
    },

    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      if (pruneTimer !== undefined) clearInterval(pruneTimer);
      const stopped = new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      await hub.stop(); // ends the open streams
      server.closeIdleConnections();
      const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
      await Promise.race([Promise.allSettled([...inflight]), grace]);
      server.closeAllConnections();
      await stopped;
    },

    get url(): string {
      return listening ?? fail("O servidor ainda não está no ar (chame listen() antes).");
    },

    hub,
  };
  return handle_;
}

/** The same error with its message and stack scrubbed (an `Error`'s own fields are not text a filter reaches). */
function scrubError(error: unknown, scrub: (text: string) => string): unknown {
  if (!(error instanceof Error)) return typeof error === "string" ? scrub(error) : error;
  const copy = new Error(
    scrub(error.message),
    error.cause === undefined ? {} : { cause: scrubError(error.cause, scrub) },
  );
  copy.name = error.name;
  if (error.stack !== undefined) copy.stack = scrub(error.stack);
  return copy;
}
