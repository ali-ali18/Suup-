// Owns the one way Suup's own search engines (Wikipedia, arXiv, Stack Overflow: direct-engines.ts)
// reach the internet: a GET to an exact host, carrying the honest user agent, through an egress
// proxy of ours (CONNECT) that lets through only the exact host names of those engines. No cookies,
// no credentials, no redirect is followed (an API answer that redirects is an answer we do not
// understand), and the answer is bounded in time and size. docs/BUSCA.md, docs/REDE.md.
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { EGRESS_REASON_HEADER, type EgressRefusalReason, egressRefusalReason } from "@suup/sandbox";

export interface DirectResponse {
  status: number;
  /** Header names in lower case. */
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface DirectGetOptions {
  signal?: AbortSignal;
  accept?: string;
}

/** A GET that carries the user agent and never throws a non-readable answer: it throws with a readable message instead. */
export type DirectGet = (url: string, options?: DirectGetOptions) => Promise<DirectResponse>;

export interface DirectGetSettings {
  /** The honest name, sent on every request. */
  userAgent: string;
  /** The egress proxy (CONNECT) the connections go through. */
  proxy?: { host: string; port: number };
  /** Test seam: where a connection to `host:port` really goes (replaces the proxy). */
  dial?(host: string, port: number): Promise<Duplex>;
  /** `false` only in tests: no TLS on the connection. Default `true`. */
  secure?: boolean;
  /** Test seam: the certificate authority that signs the server's certificate (default: the system's). */
  ca?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export const DIRECT_TIMEOUT_MS = 15_000;
export const DIRECT_MAX_BYTES = 2_000_000;

export function createDirectGet(settings: DirectGetSettings): DirectGet {
  const timeoutMs = settings.timeoutMs ?? DIRECT_TIMEOUT_MS;
  const maxBytes = settings.maxBytes ?? DIRECT_MAX_BYTES;
  const secure = settings.secure !== false;
  return async (urlText, options = {}) => {
    const url = new URL(urlText);
    if (url.protocol !== "https:") throw new Error(`only https addresses are used (${url.href})`);
    const port = url.port === "" ? 443 : Number(url.port);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const raw = await openConnection(settings, url.hostname, port, signal);
    const stream = secure
      ? tlsConnect({
          socket: raw as never,
          servername: url.hostname,
          ...(settings.ca === undefined ? {} : { ca: settings.ca }),
        })
      : raw;
    return await new Promise<DirectResponse>((resolve, reject) => {
      const request = httpRequest(
        {
          method: "GET",
          host: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          // An agent of its own whose only connection is the one already opened (through the proxy).
          agent: oneConnection(stream),
          headers: {
            host: url.host,
            "user-agent": settings.userAgent,
            accept: options.accept ?? "application/json",
            "accept-encoding": "gzip, deflate, br",
            connection: "close",
          },
        },
        (response) => {
          readBody(response, maxBytes).then(
            (body) => {
              stream.destroy();
              resolve({ status: response.statusCode ?? 0, headers: lowerHeaders(response), body });
            },
            (error) => {
              stream.destroy();
              reject(error);
            },
          );
        },
      );
      const abort = () => {
        const reason = signal.reason as unknown;
        const message =
          reason instanceof Error && reason.name === "TimeoutError"
            ? `no answer in ${timeoutMs / 1000} s`
            : "the search was cancelled";
        request.destroy(new Error(message));
        stream.destroy();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      request.on("error", (error) => {
        stream.destroy();
        reject(error);
      });
      request.end();
    });
  };
}

async function openConnection(
  settings: DirectGetSettings,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Duplex> {
  if (settings.dial !== undefined) return await settings.dial(host, port);
  const proxy = settings.proxy;
  if (proxy === undefined) throw new Error("no egress proxy is configured for the search engines");
  return await new Promise<Duplex>((resolve, reject) => {
    const target = `${host}:${port}`;
    const request = httpRequest({
      method: "CONNECT",
      host: proxy.host,
      port: proxy.port,
      path: target,
      headers: { host: target },
    });
    const abort = () => request.destroy(new Error("the connection was cancelled or timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.on("connect", (response, socket) => {
      signal.removeEventListener("abort", abort);
      if (response.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(proxyRefusal(target, response)));
      }
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

/** What each refusal code of the proxy means here, said to the person reading the tool result. */
const REFUSAL_EXPLAINED: Readonly<Record<EgressRefusalReason, string>> = {
  not_allowed: "the host is not on the engines' list",
  ip_literal: "the target is an IP address, not a host name",
  bad_host: "the target is not a valid host name",
  bad_port: "the port is not allowed",
  dns_failed: "the host name could not be resolved (no DNS answer on this computer)",
  forbidden_address:
    "the host name resolves to an address that is never reachable (private, loopback, link-local or metadata)",
  policy_unavailable: "the list of allowed hosts is not available right now; try again in a moment",
};

/**
 * The message for a CONNECT the proxy did not open. The reason comes from the proxy's own code in
 * `EGRESS_REASON_HEADER`, compared exactly with the known codes; without a known code only the
 * status is reported, with no guess at why.
 */
function proxyRefusal(target: string, response: IncomingMessage): string {
  const header = response.headers[EGRESS_REASON_HEADER];
  const reason = egressRefusalReason(Array.isArray(header) ? undefined : header);
  const status = `the egress proxy refused ${target} (HTTP ${response.statusCode ?? "?"})`;
  return reason === undefined ? status : `${status}; ${REFUSAL_EXPLAINED[reason]}`;
}

function lowerHeaders(response: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<string> {
  const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
  let source: NodeJS.ReadableStream = response;
  if (encoding === "gzip" || encoding === "x-gzip") source = response.pipe(createGunzip());
  else if (encoding === "deflate") source = response.pipe(createInflate());
  else if (encoding === "br") source = response.pipe(createBrotliDecompress());
  else if (encoding !== "" && encoding !== "identity") {
    response.destroy();
    throw new Error(`the answer uses an encoding that is not understood (${encoding})`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) {
      response.destroy();
      throw new Error(`the answer is larger than ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function oneConnection(stream: Duplex): Agent {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => stream as never;
  return agent;
}
