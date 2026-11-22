// Owns starting the containers of the web: the SearXNG search service and the reader/renderer. The
// worker (or the embedded app's sidecar) calls `startWebServices` when it first needs the web; if
// Docker is not there, nothing here throws: the result says what is unavailable and why, and the
// tools say it to the model.
//
// Network design (docs/BUSCA.md, docs/REDE.md):
//  - SearXNG lives on its own INTERNAL network (no route out). Its only way out is an egress proxy
//    of ours on that network, which lets through ONLY the exact host names of the engines that are
//    turned on: in this process (Linux), or in its own container (Docker Desktop, the embedded app on
//    Windows). It holds no secret except a random `secret_key` made for this install and, with the
//    proxy in a container, the proxy credentials of this start (they open only the engines' hosts).
//  - The reader is a container with a public route but no inbound port and no secret; the worker
//    talks to it with `docker exec`. It refuses private addresses itself (safe-fetch.ts), and its
//    browser goes through a proxy that does the same (renderer.ts).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertName,
  DEFAULT_EGRESS_IMAGE,
  dockerClientEnv,
  type EgressEvent,
  EgressProxy,
  type EgressSubject,
  ensureInternalNetwork,
  runProcess,
  startEgressContainer,
  subjectKey,
} from "@suup/sandbox";
import {
  arxivEngine,
  type DirectEngine,
  stackOverflowEngine,
  wikipediaEngine,
} from "./direct-engines.js";
import { createDirectGet, type DirectGet } from "./direct-http.js";
import {
  DEFAULT_ENGINES,
  DEFAULT_LANGUAGES,
  directEngineIds,
  engineHosts,
  SEARXNG_IMAGE,
  searxEngineIds,
} from "./engines.js";
import { httpSearxBackend, type SearxBackend } from "./search.js";
import { execSearxBackend } from "./searx-exec.js";
import { renderSearxSettings } from "./searx-settings.js";
import { createStdioReaderClient, type StdioReaderClient } from "./stdio-client.js";
import { REPOSITORY_URL, userAgent, WEB_VERSION } from "./user-agent.js";

export const SEARCH_CONTAINER = "suup-searxng";
export const READER_CONTAINER = "suup-reader";
export const SEARCH_NETWORK = "suup-search-net";
/** The engine proxy's own container, in the `container` mode of `searchProxy`. */
export const SEARCH_EGRESS_CONTAINER = "suup-egress-search";
/** Who the search container is, to the engine proxy. */
const SEARCH_SUBJECT: EgressSubject = { kind: "harness", id: "search" };
export const READER_IMAGE = "suup-reader:dev";
const SETTINGS_LABEL = "suup.web.settings";
const SEARX_PORT = 8080;

export interface WebServicesOptions {
  dockerPath?: string;
  engines?: readonly string[];
  languages?: readonly string[];
  searchEnabled?: boolean;
  /** Use a SearXNG you run yourself at this URL (JSON enabled) instead of starting the container. */
  searchUrl?: string;
  searchNetwork?: string;
  /** Name of the search container. Default `suup-searxng`. */
  searchContainer?: string;
  /**
   * Where the engine proxy runs. `process` (default): in this process, listening on the search
   * network (default: its gateway, port 3129). `container`: in its own container (the `docker/egress`
   * image, named `suup-egress-search`), joined to the search network and to an ordinary one, with its
   * control port published on 127.0.0.1 only: the topology of Docker Desktop (Windows), where this
   * process cannot listen on a Docker network (docs/REDE.md, "`container`: o proxy no contêiner `suup-egress`").
   */
  searchProxy?: {
    mode?: "process" | "container";
    /** `container` mode: the egress image. Default `suup-egress:dev`. */
    image?: string;
    /** `container` mode: the container's name. Default `suup-egress-search`. */
    name?: string;
    listenHost?: string;
    advertiseHost?: string;
    port?: number;
  };
  searxImage?: string;
  readerEnabled?: boolean;
  readerImage?: string;
  readerContainer?: string;
  /** Let the reader render pages with JavaScript (needs Chromium in the image). Default true. */
  render?: boolean;
  /** Where the user agent points (the project page). */
  repositoryUrl?: string;
  /** Test seam: the GET the direct engines use (default: through a loopback egress proxy with their exact hosts). */
  directGet?: DirectGet;
  log?: (message: string) => void;
}

export interface WebServices {
  /** `undefined`: no search service (see `searchProblem`). */
  searchBackend: SearxBackend | undefined;
  searchProblem?: string;
  /** The engines Suup asks itself through their official APIs (docs/BUSCA.md); empty when none is on. */
  direct: DirectEngine[];
  /** Where the loopback egress proxy of the direct engines listens (for the doctor and the tests). */
  directProxy?: { host: string; port: number };
  /** The URL of the engine proxy the search container goes out through (for the doctor and the tests). */
  searchProxyUrl?: string;
  engines: readonly string[];
  /** The reader container's client, or `undefined` when there is none (see `readerProblem`). */
  reader: StdioReaderClient | undefined;
  readerProblem?: string;
  stop(): Promise<void>;
}

async function docker(
  path: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runProcess(path, args, {
    env: dockerClientEnv(),
    timeoutMs: 600_000,
    maxOutputBytes: 262_144,
    killGroup: false,
    ...(input === undefined ? {} : { input: Buffer.from(input) }),
  });
  if (r.spawnError !== undefined)
    throw new Error(`could not run "${path}": ${r.spawnError.message}`);
  return { code: r.exitCode, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}

async function dockerAvailable(path: string): Promise<boolean> {
  try {
    return (await docker(path, ["info", "--format", "{{.ServerVersion}}"])).code === 0;
  } catch {
    return false;
  }
}

async function imageExists(path: string, image: string): Promise<boolean> {
  return (await docker(path, ["image", "inspect", "--format", "{{.Id}}", image])).code === 0;
}

/** Starts what is configured and can be started. Never throws for a missing Docker or image. */
export async function startWebServices(options: WebServicesOptions = {}): Promise<WebServices> {
  const path = options.dockerPath ?? "docker";
  const log = options.log ?? (() => undefined);
  const engines = options.engines ?? DEFAULT_ENGINES;
  const languages = options.languages ?? DEFAULT_LANGUAGES;
  const stoppers: (() => Promise<void>)[] = [];
  const result: WebServices = {
    searchBackend: undefined,
    direct: [],
    engines,
    reader: undefined,
    async stop() {
      for (const stop of stoppers.splice(0)) await stop().catch(() => undefined);
    },
  };

  const searxIds = searxEngineIds(engines);
  const directIds = directEngineIds(engines);
  if (options.searchEnabled !== false && options.searchUrl !== undefined && searxIds.length > 0) {
    result.searchBackend = httpSearxBackend(options.searchUrl);
  }
  // The engines Suup asks itself need no Docker: they go out through an egress proxy of the worker
  // (loopback only) that lets through just their exact hosts.
  if (options.searchEnabled !== false && directIds.length > 0) {
    try {
      const started = await startDirect({ ...options, languages }, directIds);
      result.direct = started.engines;
      if (started.proxy !== undefined) result.directProxy = started.proxy;
      stoppers.push(started.stop);
    } catch (error) {
      result.searchProblem = error instanceof Error ? error.message : String(error);
      log(`direct search engines unavailable: ${result.searchProblem}`);
    }
  }
  const wantsContainerSearch =
    options.searchEnabled !== false && options.searchUrl === undefined && searxIds.length > 0;
  if (!(await dockerAvailable(path))) {
    const why = "Docker is not available on this computer";
    if (wantsContainerSearch) result.searchProblem = why;
    if (options.readerEnabled !== false) result.readerProblem = why;
    return result;
  }

  if (wantsContainerSearch) {
    try {
      const started = await startSearch({
        ...options,
        dockerPath: path,
        engines: searxIds,
        languages,
      });
      result.searchBackend = started.backend;
      result.searchProxyUrl = started.proxyUrl;
      stoppers.push(started.stop);
    } catch (error) {
      result.searchProblem = error instanceof Error ? error.message : String(error);
      log(`web search unavailable: ${result.searchProblem}`);
    }
  }
  if (options.readerEnabled !== false) {
    try {
      const started = await startReader({ ...options, dockerPath: path });
      result.reader = started.client;
      stoppers.push(async () => started.client.close());
    } catch (error) {
      result.readerProblem = error instanceof Error ? error.message : String(error);
      log(`reader container unavailable: ${result.readerProblem}`);
    }
  }
  return result;
}

/** The engines Suup asks itself, with the honest user agent, through a loopback proxy that allows only their hosts. */
async function startDirect(
  options: WebServicesOptions & { languages: readonly string[] },
  ids: readonly string[],
): Promise<{
  engines: DirectEngine[];
  proxy: { host: string; port: number } | undefined;
  stop(): Promise<void>;
}> {
  let get = options.directGet;
  let proxyAddress: { host: string; port: number } | undefined;
  let stop = async () => {};
  if (get === undefined) {
    const hosts = new Set(engineHosts(ids, options.languages));
    const proxy = new EgressProxy({
      policy: { allowedHosts: async () => hosts },
      anonymousSubject: { kind: "harness", id: "search-direct" },
      listenHost: "127.0.0.1",
      onEvent: (event) => {
        if (event.decision === "refused") {
          options.log?.(
            `search proxy refused ${event.host}:${event.port} (${event.reason ?? "refused"})`,
          );
        }
      },
    });
    const { port } = await proxy.start();
    proxyAddress = { host: "127.0.0.1", port };
    stop = () => proxy.stop();
    get = createDirectGet({
      userAgent: userAgent(WEB_VERSION, options.repositoryUrl ?? REPOSITORY_URL),
      proxy: { host: "127.0.0.1", port },
    });
  }
  const engines: DirectEngine[] = [];
  for (const id of ids) {
    if (id === "wikipedia") engines.push(wikipediaEngine({ get, languages: options.languages }));
    else if (id === "arxiv") engines.push(arxivEngine({ get }));
    else if (id === "stackoverflow") engines.push(stackOverflowEngine({ get }));
  }
  return { engines, proxy: proxyAddress, stop };
}

/**
 * The engine proxy in this process, listening on the search network (a Linux host, or a worker in a
 * container with a fixed address). The search container is the only member of that network, so the
 * proxy asks it for no credentials.
 */
async function startProcessProxy(
  path: string,
  networkName: string,
  hosts: ReadonlySet<string>,
  onEvent: (event: EgressEvent) => void,
  options: WebServicesOptions,
): Promise<{ proxyUrl: string; stop(): Promise<void> }> {
  const net = await ensureInternalNetwork(networkName, { dockerPath: path });
  const listenHost = options.searchProxy?.listenHost ?? net.gateway;
  const advertiseHost = options.searchProxy?.advertiseHost ?? listenHost;
  const configuredPort = options.searchProxy?.port ?? 3129;
  const proxy = new EgressProxy({
    policy: { allowedHosts: async () => hosts },
    anonymousSubject: SEARCH_SUBJECT,
    listenHost,
    listenPort: configuredPort,
    onEvent,
    ...(options.searchProxy?.advertiseHost === undefined ? {} : { advertiseHost }),
  });
  let proxyStarted = true;
  let port = configuredPort;
  try {
    port = (await proxy.start()).port;
  } catch (error) {
    // Another Suup process on this computer already serves the engine proxy on that address.
    if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    proxyStarted = false;
  }
  return {
    proxyUrl: `http://${advertiseHost.includes(":") ? `[${advertiseHost}]` : advertiseHost}:${port}`,
    stop: async () => {
      if (proxyStarted) await proxy.stop();
    },
  };
}

/**
 * The engine proxy in its own container (the same image and code as the bots' proxy container). It
 * has no list of its own: it asks this process, through the control channel, and the answer is the
 * engines' exact hosts for the search container and nothing for anyone else. The search container
 * proves who it is with the credentials in the proxy URL (made for this start; they open only that
 * list).
 */
async function startContainerProxy(
  path: string,
  networkName: string,
  hosts: ReadonlySet<string>,
  onEvent: (event: EgressEvent) => void,
  options: WebServicesOptions,
): Promise<{ proxyUrl: string; stop(): Promise<void> }> {
  const searchKey = subjectKey(SEARCH_SUBJECT);
  const none: ReadonlySet<string> = new Set();
  const egress = await startEgressContainer({
    dockerPath: path,
    image: options.searchProxy?.image ?? DEFAULT_EGRESS_IMAGE,
    name: options.searchProxy?.name ?? SEARCH_EGRESS_CONTAINER,
    internalNetwork: networkName,
    policy: {
      allowedHosts: async (subject) => (subjectKey(subject) === searchKey ? hosts : none),
    },
    onEvent,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const proxyUrl = egress.envFor(SEARCH_SUBJECT).HTTP_PROXY;
  if (proxyUrl === undefined) {
    await egress.stop();
    throw new Error("the engine proxy container gave no proxy address");
  }
  return { proxyUrl, stop: () => egress.stop() };
}

async function startSearch(
  options: WebServicesOptions & {
    dockerPath: string;
    engines: readonly string[];
    languages: readonly string[];
  },
): Promise<{ backend: SearxBackend; proxyUrl: string; stop(): Promise<void> }> {
  const path = options.dockerPath;
  const container = options.searchContainer ?? SEARCH_CONTAINER;
  assertName(container, "search container name");
  const networkName = options.searchNetwork ?? SEARCH_NETWORK;
  assertName(networkName, "search network name");
  const image = options.searxImage ?? SEARXNG_IMAGE;
  const hosts = new Set(engineHosts(options.engines, options.languages));
  const onEvent = (event: EgressEvent) => {
    if (event.decision === "refused") {
      options.log?.(
        `search proxy refused ${event.host}:${event.port} (${event.reason ?? "refused"})`,
      );
    }
  };
  const { proxyUrl, stop } =
    options.searchProxy?.mode === "container"
      ? await startContainerProxy(path, networkName, hosts, onEvent, options)
      : await startProcessProxy(path, networkName, hosts, onEvent, options);
  const settings = renderSearxSettings({
    engines: options.engines,
    proxyUrl,
    port: SEARX_PORT,
    userAgent: userAgent(WEB_VERSION, options.repositoryUrl ?? REPOSITORY_URL),
  });

  const state = await docker(path, [
    "inspect",
    "--format",
    `{{.State.Running}} {{index .Config.Labels "${SETTINGS_LABEL}"}}`,
    container,
  ]);
  const wanted = `${image} ${hashOf(settings)}`;
  if (state.code === 0 && state.stdout.trim() === `true ${wanted}`) {
    return {
      backend: execSearxBackend({ container, port: SEARX_PORT, dockerPath: path }),
      proxyUrl,
      stop,
    };
  }
  if (state.code === 0) await docker(path, ["rm", "--force", container]);
  if (!(await imageExists(path, image))) {
    const pulled = await docker(path, ["pull", "--quiet", image]);
    if (pulled.code !== 0) {
      await stop();
      throw new Error(
        `the SearXNG image ${image} is not here and could not be pulled: ${pulled.stderr.trim().split("\n")[0] ?? ""}`,
      );
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "suup-searx-"));
  try {
    const file = join(dir, "settings.yml");
    await writeFile(file, settings, { mode: 0o644 });
    const created = await docker(path, [
      "create",
      "--name",
      container,
      "--network",
      networkName,
      "--restart",
      "unless-stopped",
      "--init",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--label",
      "suup.managed=1",
      "--label",
      `${SETTINGS_LABEL}=${wanted}`,
      // The image listens on `::` by default; our internal network is IPv4, and a kernel without IPv6 cannot bind it.
      "--env",
      "GRANIAN_HOST=0.0.0.0",
      "--env",
      `SEARXNG_SECRET=${randomBytes(32).toString("hex")}`,
      image,
    ]);
    if (created.code !== 0)
      throw new Error(`could not create the search container: ${created.stderr.trim()}`);
    const copied = await docker(path, ["cp", file, `${container}:/etc/searxng/settings.yml`]);
    if (copied.code !== 0)
      throw new Error(
        `could not put the settings in the search container: ${copied.stderr.trim()}`,
      );
    const started = await docker(path, ["start", container]);
    if (started.code !== 0)
      throw new Error(`could not start the search container: ${started.stderr.trim()}`);
    await waitUntilReady(path, container);
  } catch (error) {
    await docker(path, ["rm", "--force", container]).catch(() => undefined);
    await stop();
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    backend: execSearxBackend({ container, port: SEARX_PORT, dockerPath: path }),
    proxyUrl,
    stop,
  };
}

/** Waits for the search container to answer on its own loopback (SearXNG takes a few seconds to start). */
async function waitUntilReady(path: string, container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = await docker(path, [
      "exec",
      container,
      "wget",
      "--quiet",
      "--output-document=-",
      "--timeout=3",
      "--tries=1",
      `http://127.0.0.1:${SEARX_PORT}/healthz`,
    ]);
    if (probe.code === 0) return;
    await new Promise<void>((done) => setTimeout(done, 500));
  }
  const logs = await docker(path, ["logs", "--tail", "15", container]);
  throw new Error(
    `the search container did not become ready: ${(logs.stdout + logs.stderr).trim().split("\n").slice(-4).join(" | ")}`,
  );
}

function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

async function startReader(
  options: WebServicesOptions & { dockerPath: string },
): Promise<{ client: StdioReaderClient }> {
  const path = options.dockerPath;
  const name = options.readerContainer ?? READER_CONTAINER;
  assertName(name, "reader container name");
  const image = options.readerImage ?? READER_IMAGE;
  if (!(await imageExists(path, image))) {
    throw new Error(
      `the reader image ${image} is not built (docker build -f docker/reader/Dockerfile -t ${image} .)`,
    );
  }
  const render = options.render !== false;
  const state = await docker(path, [
    "inspect",
    "--format",
    "{{.State.Running}} {{.Config.Image}}",
    name,
  ]);
  if (!(state.code === 0 && state.stdout.trim() === `true ${image}`)) {
    if (state.code === 0) await docker(path, ["rm", "--force", name]);
    const made = await docker(path, [
      "run",
      "--detach",
      "--name",
      name,
      "--restart",
      "unless-stopped",
      "--init",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m",
      "--shm-size",
      "512m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "--cpus",
      "1",
      "--pids-limit",
      "512",
      "--label",
      "suup.managed=1",
      image,
      "sleep",
      "infinity",
    ]);
    if (made.code !== 0)
      throw new Error(`could not start the reader container: ${made.stderr.trim()}`);
  }
  const env: string[] = [];
  if (render)
    env.push("--env", "SUUP_RENDER=1", "--env", "SUUP_RENDER_NO_SANDBOX=1", "--env", "HOME=/tmp");
  if (options.repositoryUrl !== undefined)
    env.push("--env", `SUUP_REPOSITORY_URL=${options.repositoryUrl}`);
  const client = createStdioReaderClient({
    command: path,
    args: ["exec", "-i", ...env, name, "node", "/app/dist/serve.js"],
    env: dockerClientEnv(),
  });
  await client.start();
  return { client };
}
