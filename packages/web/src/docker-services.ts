// Owns starting the containers of the web: the SearXNG search service and the reader/renderer. The
// worker (or the embedded app's sidecar) calls `startWebServices` when it first needs the web; if
// Docker is not there, nothing here throws: the result says what is unavailable and why, and the
// tools say it to the model.
//
// Network design (docs/BUSCA.md, docs/REDE.md):
//  - SearXNG lives alone on its own INTERNAL network (no route out). Its only way out is an egress
//    proxy of ours on that network, which lets through ONLY the exact host names of the engines
//    that are turned on. It holds no secret except a random `secret_key` made for this install.
//  - The reader is a container with a public route but no inbound port and no secret; the worker
//    talks to it with `docker exec`. It refuses private addresses itself (safe-fetch.ts), and its
//    browser goes through a proxy that does the same (renderer.ts).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertName,
  dockerClientEnv,
  EgressProxy,
  ensureInternalNetwork,
  runProcess,
} from "@suup/sandbox";
import { DEFAULT_ENGINES, DEFAULT_LANGUAGES, engineHosts, SEARXNG_IMAGE } from "./engines.js";
import { httpSearxBackend, type SearxBackend } from "./search.js";
import { execSearxBackend } from "./searx-exec.js";
import { renderSearxSettings } from "./searx-settings.js";
import { createStdioReaderClient, type StdioReaderClient } from "./stdio-client.js";

export const SEARCH_CONTAINER = "suup-searxng";
export const READER_CONTAINER = "suup-reader";
export const SEARCH_NETWORK = "suup-search-net";
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
  /** Where the engine proxy listens on the search network; default: its gateway, port 3129. */
  searchProxy?: { listenHost?: string; advertiseHost?: string; port?: number };
  searxImage?: string;
  readerEnabled?: boolean;
  readerImage?: string;
  readerContainer?: string;
  /** Let the reader render pages with JavaScript (needs Chromium in the image). Default true. */
  render?: boolean;
  /** Where the user agent points (the project page). */
  repositoryUrl?: string;
  log?: (message: string) => void;
}

export interface WebServices {
  /** `undefined`: no search service (see `searchProblem`). */
  searchBackend: SearxBackend | undefined;
  searchProblem?: string;
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
    engines,
    reader: undefined,
    async stop() {
      for (const stop of stoppers.splice(0)) await stop().catch(() => undefined);
    },
  };

  if (options.searchEnabled !== false && options.searchUrl !== undefined) {
    result.searchBackend = httpSearxBackend(options.searchUrl);
  }
  const wantsContainerSearch = options.searchEnabled !== false && options.searchUrl === undefined;
  if (!(await dockerAvailable(path))) {
    const why = "Docker is not available on this computer";
    if (wantsContainerSearch) result.searchProblem = why;
    if (options.readerEnabled !== false) result.readerProblem = why;
    return result;
  }

  if (wantsContainerSearch) {
    try {
      const started = await startSearch({ ...options, dockerPath: path, engines, languages });
      result.searchBackend = started.backend;
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

async function startSearch(
  options: WebServicesOptions & {
    dockerPath: string;
    engines: readonly string[];
    languages: readonly string[];
  },
): Promise<{ backend: SearxBackend; stop(): Promise<void> }> {
  const path = options.dockerPath;
  const networkName = options.searchNetwork ?? SEARCH_NETWORK;
  assertName(networkName, "search network name");
  const image = options.searxImage ?? SEARXNG_IMAGE;
  const net = await ensureInternalNetwork(networkName, { dockerPath: path });
  const listenHost = options.searchProxy?.listenHost ?? net.gateway;
  const advertiseHost = options.searchProxy?.advertiseHost ?? listenHost;
  const port = options.searchProxy?.port ?? 3129;
  const hosts = new Set(engineHosts(options.engines, options.languages));
  const proxy = new EgressProxy({
    policy: { allowedHosts: async () => hosts },
    anonymousSubject: { kind: "harness", id: "search" },
    listenHost,
    listenPort: port,
    ...(options.searchProxy?.advertiseHost === undefined ? {} : { advertiseHost }),
  });
  let proxyStarted = true;
  try {
    await proxy.start();
  } catch (error) {
    // Another Suup process on this computer already serves the engine proxy on that address.
    if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    proxyStarted = false;
  }
  const settings = renderSearxSettings({
    engines: options.engines,
    proxyUrl: `http://${advertiseHost.includes(":") ? `[${advertiseHost}]` : advertiseHost}:${port}`,
    port: SEARX_PORT,
  });
  const stop = async () => {
    if (proxyStarted) await proxy.stop();
  };

  const state = await docker(path, [
    "inspect",
    "--format",
    `{{.State.Running}} {{index .Config.Labels "${SETTINGS_LABEL}"}}`,
    SEARCH_CONTAINER,
  ]);
  const wanted = `${image} ${hashOf(settings)}`;
  if (state.code === 0 && state.stdout.trim() === `true ${wanted}`) {
    return {
      backend: execSearxBackend({
        container: SEARCH_CONTAINER,
        port: SEARX_PORT,
        dockerPath: path,
      }),
      stop,
    };
  }
  if (state.code === 0) await docker(path, ["rm", "--force", SEARCH_CONTAINER]);
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
      SEARCH_CONTAINER,
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
      "--env",
      `SEARXNG_SECRET=${randomBytes(32).toString("hex")}`,
      image,
    ]);
    if (created.code !== 0)
      throw new Error(`could not create the search container: ${created.stderr.trim()}`);
    const copied = await docker(path, [
      "cp",
      file,
      `${SEARCH_CONTAINER}:/etc/searxng/settings.yml`,
    ]);
    if (copied.code !== 0)
      throw new Error(
        `could not put the settings in the search container: ${copied.stderr.trim()}`,
      );
    const started = await docker(path, ["start", SEARCH_CONTAINER]);
    if (started.code !== 0)
      throw new Error(`could not start the search container: ${started.stderr.trim()}`);
  } catch (error) {
    await docker(path, ["rm", "--force", SEARCH_CONTAINER]).catch(() => undefined);
    await stop();
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    backend: execSearxBackend({ container: SEARCH_CONTAINER, port: SEARX_PORT, dockerPath: path }),
    stop,
  };
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
  if (render) env.push("--env", "SUUP_RENDER=1", "--env", "SUUP_RENDER_NO_SANDBOX=1");
  if (options.repositoryUrl !== undefined)
    env.push("--env", `SUUP_REPOSITORY_URL=${options.repositoryUrl}`);
  const client = createStdioReaderClient({
    command: path,
    args: ["exec", "-i", ...env, name, "node", "/app/packages/web/dist/serve.js"],
    env: dockerClientEnv(),
  });
  await client.start();
  return { client };
}
