// Owns the HTTP(S) proxy the bots' machines reach the internet through. It runs in the harness,
// OUTSIDE the container: the container has no route of its own, so this is the only way out. It
// answers `CONNECT host:port` (HTTPS and anything else tunnelled) and absolute-URI `GET http://...`
// requests, and for each one: identifies the subject from `Proxy-Authorization`, asks the policy
// for the subject's exact allowlist, decides by `decideHost` (equality, no patterns), resolves the
// name once, refuses forbidden addresses, and connects to the address it validated.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, Socket } from "node:net";
import { DEFAULT_ALLOWED_PORTS, decideHost, normalizeHost } from "@suup/core";
import { type Resolver, resolveForConnect, systemResolver } from "./resolve.js";
import { RefusalSessions } from "./sessions.js";
import {
  type EgressEvent,
  type EgressPolicy,
  type EgressService,
  type EgressSession,
  type EgressSubject,
  subjectKey,
} from "./types.js";

export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** Where to listen (the address the machines reach: the gateway of their internal network). */
  listenHost: string;
  /** 0: the system picks. */
  listenPort?: number;
  /** The address written into the machines' proxy settings. Default: `listenHost`. */
  advertiseHost?: string;
  ports?: readonly number[];
  resolver?: Resolver;
  /** How the validated address is connected to. Default `net.connect`; tests point it at a local server. */
  dial?(address: string, port: number): Socket;
  /**
   * Every decision (allowed and refused). The runtime stores the refusals. A refusal is answered to
   * the client only AFTER a returned promise settles, so the party that owns the policy has seen it first.
   */
  onEvent?(event: EgressEvent): unknown;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  /**
   * Any valid public host NAME may be reached, not only the ones on the allowlist. Everything else
   * stays: no IP literal, only `ports`, and the resolved address must be a public one (checked once;
   * the connection goes to that address). For the page renderer, whose universe of sites is open
   * (docs/BUSCA.md); the bots' machines never use it.
   */
  openWeb?: boolean;
  /**
   * Every connection counts as this subject, with no credentials asked. Only for a proxy that
   * listens on a network whose one member is the container it serves (the search container).
   */
  anonymousSubject?: EgressSubject;
  /**
   * The key the subject tokens derive from. Default: a random one made here. The worker and a proxy
   * that runs in a container (`control.ts`) share one, so the worker can write the credentials the
   * proxy will accept.
   */
  secret?: Buffer;
}

/** The credential of a subject: proves who is asking, nothing else. */
export function subjectToken(secret: Buffer, subject: EgressSubject): string {
  return createHmac("sha256", secret).update(subjectKey(subject)).digest("hex").slice(0, 32);
}

/** The environment that points a command's network tools at the proxy `url`. */
export function proxyEnv(url: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = url;
    env[name.toLowerCase()] = url;
  }
  // Explicitly empty: nothing is exempt from the proxy (and there is no route around it anyway).
  env.NO_PROXY = "";
  env.no_proxy = "";
  return env;
}

/** The URL of a proxy for a subject (host written the way a URL needs it). */
export function proxyUrl(
  secret: Buffer,
  subject: EgressSubject,
  host: string,
  port: number,
): string {
  const hostText = host.includes(":") ? `[${host}]` : host;
  return `http://${subjectKey(subject)}:${subjectToken(secret, subject)}@${hostText}:${port}`;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class EgressProxy implements EgressService {
  readonly #options: EgressProxyOptions;
  readonly #secret: Buffer;
  readonly #server: Server;
  readonly #sessions = new RefusalSessions();
  readonly #sockets = new Set<Socket>();
  #port = 0;

  constructor(options: EgressProxyOptions) {
    this.#options = options;
    this.#secret = options.secret ?? randomBytes(32);
    this.#server = createServer((req, res) => void this.#plain(req, res));
    this.#server.on("connect", (req, socket, head) => {
      if (socket instanceof Socket) void this.#tunnel(req, socket, head);
      else socket.destroy();
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
  }

  /** Starts listening. Returns the address the machines use. */
  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.listenPort ?? 0, this.#options.listenHost, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    this.#port = typeof address === "object" && address !== null ? address.port : 0;
    return { host: this.#options.advertiseHost ?? this.#options.listenHost, port: this.#port };
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get port(): number {
    return this.#port;
  }

  /** The proxy URL a subject's commands use. The password only proves who is asking. */
  proxyUrlFor(subject: EgressSubject): string {
    return proxyUrl(
      this.#secret,
      subject,
      this.#options.advertiseHost ?? this.#options.listenHost,
      this.#port,
    );
  }

  open(subject: EgressSubject): EgressSession {
    const window = this.#sessions.open(subject);
    return { env: this.envFor(subject), close: () => window.close() };
  }

  envFor(subject: EgressSubject): Record<string, string> {
    return proxyEnv(this.proxyUrlFor(subject));
  }

  #dial(address: string, port: number): Socket {
    return this.#options.dial?.(address, port) ?? connect({ host: address, port });
  }

  #tokenFor(subject: EgressSubject): string {
    return subjectToken(this.#secret, subject);
  }

  /** The subject named by the credentials, or `undefined` when they do not prove one. */
  #identify(header: string | undefined): EgressSubject | undefined {
    if (header === undefined || !header.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) return undefined;
    const user = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    const dot = user.indexOf(".");
    if (dot < 1) return undefined;
    const kind = user.slice(0, dot);
    const id = user.slice(dot + 1);
    if ((kind !== "bot" && kind !== "connector" && kind !== "harness") || id === "")
      return undefined;
    const subject: EgressSubject = { kind, id };
    const expected = Buffer.from(this.#tokenFor(subject));
    const given = Buffer.from(password);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return subject;
  }

  /** Common front of both paths: identify, decide, resolve. Reports the event. */
  async #admit(
    header: string | undefined,
    host: string,
    port: number,
  ): Promise<
    | { ok: true; subject: EgressSubject; name: string; address: string }
    | { ok: false; status: 403 | 407; message: string }
  > {
    const subject = this.#options.anonymousSubject ?? this.#identify(header);
    if (subject === undefined) {
      return { ok: false, status: 407, message: "proxy credentials are missing or wrong" };
    }
    let allowed: ReadonlySet<string>;
    if (this.#options.openWeb === true) {
      allowed = openSetFor(host);
    } else {
      try {
        allowed = await this.#options.policy.allowedHosts(subject);
      } catch {
        // The party that owns the list cannot be asked (the server is restarting): nothing is allowed.
        const message = "the allowlist is not available right now; try again in a moment";
        await this.#refuse(subject, host, port, "policy_unavailable", message);
        return { ok: false, status: 403, message };
      }
    }
    const verdict = decideHost(
      { host, port },
      allowed,
      this.#options.ports ?? DEFAULT_ALLOWED_PORTS,
    );
    if (!verdict.allow) {
      await this.#refuse(subject, verdict.host, port, verdict.reason, verdict.message);
      return { ok: false, status: 403, message: verdict.message };
    }
    const resolved = await resolveForConnect(
      verdict.host,
      this.#options.resolver ?? systemResolver,
    );
    if (!resolved.ok) {
      await this.#refuse(subject, verdict.host, port, resolved.reason, resolved.message);
      return { ok: false, status: 403, message: resolved.message };
    }
    void this.#report({
      subject,
      host: verdict.host,
      port,
      decision: "allowed",
      at: new Date(),
    });
    return { ok: true, subject, name: verdict.host, address: resolved.address };
  }

  async #refuse(
    subject: EgressSubject,
    host: string,
    port: number,
    reason: string,
    message: string,
  ): Promise<void> {
    this.#sessions.refused(subject, { host, port, reason, message });
    await this.#report({
      subject,
      host,
      port,
      decision: "refused",
      reason,
      message,
      at: new Date(),
    });
  }

  /** Hands an event to the owner of the policy; a failure there never breaks the connection. */
  async #report(event: EgressEvent): Promise<void> {
    try {
      await this.#options.onEvent?.(event);
    } catch {
      // The decision stands; only the record of it was lost.
    }
  }

  async #tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    const target = parseAuthority(req.url ?? "");
    if (target === undefined) return reply(client, 400, "bad CONNECT target");
    if (this.#sockets.size > (this.#options.maxConnections ?? 256)) {
      return reply(client, 503, "too many connections");
    }
    const admitted = await this.#admit(
      req.headers["proxy-authorization"],
      target.host,
      target.port,
    );
    if (!admitted.ok) return reply(client, admitted.status, admitted.message);
    const upstream = this.#dial(admitted.address, target.port);
    const idle = this.#options.idleTimeoutMs ?? 120_000;
    upstream.setTimeout(this.#options.connectTimeoutMs ?? 10_000, () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.setTimeout(idle, () => upstream.destroy());
      client.setTimeout(idle, () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (client.writable && !upstream.connecting && upstream.bytesRead === 0) {
        reply(client, 502, `could not connect to ${admitted.name}`);
      } else {
        client.destroy();
      }
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  async #plain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res
        .writeHead(400, { "content-type": "text/plain" })
        .end("this is a proxy: send an absolute URL\n");
      return;
    }
    if (url.protocol !== "http:") {
      res
        .writeHead(400, { "content-type": "text/plain" })
        .end("only http URLs are proxied this way\n");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const admitted = await this.#admit(req.headers["proxy-authorization"], url.hostname, port);
    if (!admitted.ok) {
      res
        .writeHead(admitted.status, {
          "content-type": "text/plain",
          ...(admitted.status === 407 ? { "proxy-authenticate": 'Basic realm="suup"' } : {}),
        })
        .end(`${admitted.message}\n`);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    }
    headers.host = url.host;
    const upstream = httpRequest({
      host: admitted.address,
      port,
      createConnection: () => this.#dial(admitted.address, port),
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: this.#options.connectTimeoutMs ?? 10_000,
    });
    upstream.on("response", (answer) => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
      }
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`could not connect to ${admitted.name}\n`);
    });
    req.pipe(upstream);
  }
}

/** For `openWeb`: a set holding just this name, so `decideHost` still does every other check. */
function openSetFor(host: string): ReadonlySet<string> {
  const normalized = normalizeHost(host);
  return normalized.kind === "name" ? new Set([normalized.name]) : new Set();
}

function reply(client: Socket, status: number, message: string): void {
  const text =
    status === 407 ? "Proxy Authentication Required" : status === 403 ? "Forbidden" : "Error";
  client.end(
    `HTTP/1.1 ${status} ${text}\r\n` +
      (status === 407 ? 'Proxy-Authenticate: Basic realm="suup"\r\n' : "") +
      "Content-Type: text/plain\r\nConnection: close\r\n" +
      `X-Suup-Egress: ${message.replaceAll("\r", " ").replaceAll("\n", " ")}\r\n\r\n${message}\n`,
  );
}

/** `host:port` or `[v6]:port` of a CONNECT line. Digits are checked one by one. */
export function parseAuthority(text: string): { host: string; port: number } | undefined {
  let host: string;
  let portText: string;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0 || text[close + 1] !== ":") return undefined;
    host = text.slice(0, close + 1);
    portText = text.slice(close + 2);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon < 1) return undefined;
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
  }
  if (portText === "" || portText.length > 5) return undefined;
  for (let i = 0; i < portText.length; i++) {
    const code = portText.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return undefined;
  }
  const port = Number(portText);
  return port >= 1 && port <= 65535 ? { host, port } : undefined;
}
