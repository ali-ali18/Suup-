// Owns the one way the reader service reaches a public web page: a read-only GET to a host NAME,
// to an address that was validated ONCE (the connection goes to that address, never to the name
// again, so a DNS answer that changes in between cannot send it somewhere else). No cookies, no
// credentials, no custom headers, only ports 80 and 443, every redirect checked again, and limits
// on time and size. See docs/REDE.md ("A leitura de páginas") and docs/BUSCA.md.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { normalizeHost } from "@suup/core";
import { type Resolver, resolveForConnect, systemResolver } from "@suup/sandbox";

export const WEB_MAX_REDIRECTS = 5;
export const WEB_MAX_BYTES = 5_000_000;
export const WEB_TIMEOUT_MS = 20_000;
export const WEB_PORTS: readonly number[] = [80, 443];

export type FetchRefusal =
  | "invalid_url"
  | "private"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "failed";

/**
 * Where a request that never got an answer stopped, for the logs (never for the model or the user):
 * the DNS lookup, the connection, the TLS handshake, the time limit, or the transfer. Its presence
 * means the site could not be REACHED from here; it says nothing about what the site wants.
 */
export interface FetchDiagnostic {
  stage: "dns" | "connect" | "tls" | "timeout" | "transfer";
  host: string;
  /** The error code of the system or of TLS (`EAI_AGAIN`, `ENETUNREACH`, `SELF_SIGNED_CERT_IN_CHAIN`...). */
  code?: string;
  /** The addresses tried, in order (the DNS answer, all of them checked). */
  addresses?: string[];
  /** The error's own text. */
  detail?: string;
}

export type SafeResponse =
  | {
      ok: true;
      /** The URL after redirects. */
      url: string;
      status: number;
      contentType: string;
      body: Buffer;
      redirects: number;
    }
  | { ok: false; reason: FetchRefusal; message: string; diagnostic?: FetchDiagnostic };

/** A connection that failed with one of these never reached the server: the next address is tried. */
const CONNECT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "ETIMEDOUT",
]);

/** The DNS said the name does not exist (as opposed to a lookup that failed on this side). */
const NO_SUCH_NAME_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

export interface SafeFetchOptions {
  userAgent: string;
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  signal?: AbortSignal;
  /** Test seam: where an (http) connection really goes. The address was validated before this. */
  dial?(address: string, port: number): Socket;
}

/** `new URL` that never throws, for a text typed by a model. */
export function parseWebUrl(text: string): URL | undefined {
  try {
    return new URL(text.trim());
  } catch {
    return undefined;
  }
}

/** Why a URL may not be fetched at all (before any network), or `undefined` when it may. */
export function checkWebUrl(
  url: URL,
): { reason: "invalid_url" | "private"; message: string } | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      reason: "invalid_url",
      message: `Only http and https pages can be read, not ${url.protocol.slice(0, -1)}.`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      reason: "invalid_url",
      message:
        "A URL with a user name or password is refused (credentials never go in a page request).",
    };
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!WEB_PORTS.includes(port)) {
    return { reason: "invalid_url", message: `Port ${port} is not allowed (only 80 and 443).` };
  }
  const host = normalizeHost(url.hostname);
  if (host.kind === "ip") {
    return {
      reason: "private",
      message: `${url.hostname} is an IP address. Pages are read by host name, never by address.`,
    };
  }
  if (host.kind === "invalid") {
    return {
      reason: "private",
      message: `${url.hostname} is not a public host name (a name like example.com is needed; names such as localhost are refused).`,
    };
  }
  return undefined;
}

/** GET with every guard. Never throws. */
export async function safeGet(urlText: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const resolver = options.resolver ?? systemResolver;
  const maxBytes = options.maxBytes ?? WEB_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? WEB_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? WEB_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  let current = parseWebUrl(urlText);
  if (current === undefined) {
    return {
      ok: false,
      reason: "invalid_url",
      message: `${JSON.stringify(urlText)} is not a valid absolute URL.`,
    };
  }
  let redirects = 0;
  for (;;) {
    const refused = checkWebUrl(current);
    if (refused !== undefined) return { ok: false, ...refused };
    const resolved = await resolveForConnect(normalizeName(current.hostname), resolver);
    if (!resolved.ok) {
      if (resolved.reason === "forbidden_address") {
        return {
          ok: false,
          reason: "private",
          message: `${current.hostname} points to a private, loopback, link-local or metadata address, so it is not read.`,
        };
      }
      const noSuchName = resolved.code !== undefined && NO_SUCH_NAME_CODES.has(resolved.code);
      return {
        ok: false,
        reason: "failed",
        message: noSuchName
          ? `${current.hostname} could not be found: check the spelling of the domain (if it is right, the DNS on this side may be failing).`
          : `The name ${current.hostname} could not be looked up from here right now (a DNS problem on this side, not the site).`,
        diagnostic: {
          stage: "dns",
          host: current.hostname,
          ...(resolved.code === undefined ? {} : { code: resolved.code }),
        },
      };
    }
    let step: Step | undefined;
    // Every address of the answer was checked; a connection that never reached the server (no
    // route for IPv6, refused) goes on to the next one.
    const tried: string[] = [];
    let failure: unknown;
    for (const address of resolved.addresses) {
      tried.push(address);
      try {
        step = await getOnce(current, address, options, maxBytes, signal);
        break;
      } catch (error) {
        failure = error;
        const code = errorCode(error);
        if (signal.aborted || code === undefined || !CONNECT_CODES.has(code)) break;
      }
    }
    if (step === undefined) {
      const code = errorCode(failure);
      const diagnostic = (stage: FetchDiagnostic["stage"]): FetchDiagnostic => ({
        stage,
        host: current?.hostname ?? "",
        addresses: tried,
        ...(code === undefined ? {} : { code }),
        ...(failure instanceof Error ? { detail: failure.message } : {}),
      });
      if (timeout.aborted) {
        return {
          ok: false,
          reason: "timeout",
          message: `Reading ${current.href} took too long and was stopped.`,
          diagnostic: diagnostic("timeout"),
        };
      }
      if (options.signal?.aborted === true) {
        return { ok: false, reason: "failed", message: "The read was cancelled." };
      }
      return {
        ok: false,
        reason: "failed",
        message: failureText(current, failure),
        diagnostic: diagnostic(stageOf(code)),
      };
    }
    if (step.kind === "too_large") {
      return {
        ok: false,
        reason: "too_large",
        message: `The page is larger than ${Math.round(maxBytes / 1_000_000)} MB, so it was not read.`,
      };
    }
    if (step.kind === "redirect") {
      redirects += 1;
      if (redirects > maxRedirects) {
        return {
          ok: false,
          reason: "too_many_redirects",
          message: `Too many redirects (limit ${maxRedirects}).`,
        };
      }
      const next = parseWebUrl(new URL(step.location, current).href);
      if (next === undefined) {
        return {
          ok: false,
          reason: "failed",
          message: "The page redirected to an invalid address.",
        };
      }
      current = next;
      continue;
    }
    return {
      ok: true,
      url: current.href,
      status: step.status,
      contentType: step.contentType,
      body: step.body,
      redirects,
    };
  }
}

type Step =
  | { kind: "done"; status: number; contentType: string; body: Buffer }
  | { kind: "redirect"; location: string }
  | { kind: "too_large" };

function normalizeName(hostname: string): string {
  const host = normalizeHost(hostname);
  return host.kind === "name" ? host.name : hostname;
}

function getOnce(
  url: URL,
  address: string,
  options: SafeFetchOptions,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Step> {
  return new Promise<Step>((resolve, reject) => {
    const https = url.protocol === "https:";
    const port = url.port === "" ? (https ? 443 : 80) : Number(url.port);
    const send = https ? httpsRequest : httpRequest;
    const request = send(
      {
        // The name is kept for the Host header and TLS (SNI, certificate check); the socket goes to
        // the address that was validated.
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host: url.host,
          "user-agent": options.userAgent,
          accept:
            options.accept ??
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
        },
        lookup: (_name, _opts, done) => {
          (done as (e: Error | null, a: string, f: number) => void)(
            null,
            address,
            address.includes(":") ? 6 : 4,
          );
        },
        ...(options.dial !== undefined && !https
          ? { createConnection: () => options.dial?.(address, port) as Socket }
          : {}),
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string" && location !== "") {
          response.resume();
          resolve({ kind: "redirect", location });
          return;
        }
        readBody(response, maxBytes).then(
          (body) =>
            resolve(
              body === undefined
                ? { kind: "too_large" }
                : {
                    kind: "done",
                    status,
                    contentType: headerText(response.headers["content-type"]),
                    body,
                  },
            ),
          reject,
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** The decoded body, or `undefined` when it is bigger than `maxBytes` (counted AFTER decompression). */
function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const encoding = headerText(response.headers["content-encoding"]).trim().toLowerCase();
  const stream =
    encoding === "gzip" || encoding === "x-gzip"
      ? response.pipe(createGunzip())
      : encoding === "deflate"
        ? response.pipe(createInflate())
        : encoding === "br"
          ? response.pipe(createBrotliDecompress())
          : response;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    stream.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        response.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error) => (over ? undefined : reject(error)));
    response.on("error", (error) => (over ? undefined : reject(error)));
  });
}

/** Which step failed, by the error code (compared exactly). */
function stageOf(code: string | undefined): FetchDiagnostic["stage"] {
  if (code === undefined) return "transfer";
  if (CONNECT_CODES.has(code)) return "connect";
  if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || CERT_CODES.has(code))
    return "tls";
  return "transfer";
}

/** The certificate errors of Node's TLS (`tls.connect`), as their codes. */
const CERT_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function failureText(url: URL, error: unknown): string {
  const code = errorCode(error);
  if (code === "ECONNREFUSED")
    return `Could not connect to ${url.hostname}: the server refused the connection.`;
  if (code === "ECONNRESET") return `The connection to ${url.hostname} was interrupted.`;
  if (code !== undefined && CERT_CODES.has(code)) {
    return `The TLS certificate of ${url.hostname} could not be verified from here (something on this side, such as an antivirus or proxy that inspects HTTPS, may be in the way).`;
  }
  if (code?.startsWith("ERR_TLS") === true || code?.startsWith("ERR_SSL") === true)
    return `The TLS handshake with ${url.hostname} failed.`;
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH")
    return `There is no network route from here to ${url.hostname} right now.`;
  if (code === "ETIMEDOUT") return `The connection to ${url.hostname} timed out.`;
  return `Reading ${url.href} failed${error instanceof Error ? `: ${error.message}` : ""}.`;
}
