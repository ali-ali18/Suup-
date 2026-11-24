// Owns starting what the web needs: the engines Suup asks itself (in this process, through a loopback
// egress proxy that lets through only their exact hosts, no Docker) and the reader/renderer container.
// The worker (or the embedded app's sidecar) calls `startWebServices` when it first needs the web; if
// Docker is not there, nothing here throws: the result says what is unavailable and why, and the
// tools say it to the model.
//
// Network design (docs/BUSCA.md, docs/REDE.md):
//  - The search engines (Wikipedia, arXiv, Stack Overflow, Tavily, Brave) are asked by this process
//    through its own egress proxy on 127.0.0.1, which lets through ONLY their exact host names.
//    General search needs no Docker.
//  - The reader is a container with a public route but no inbound port and no secret; the worker
//    talks to it with `docker exec`. It refuses private addresses itself (safe-fetch.ts), and its
//    browser goes through a proxy that does the same (renderer.ts).
import { assertName, dockerClientEnv, EgressProxy, runProcess } from "@suup/sandbox";
import {
  arxivEngine,
  type DirectEngine,
  stackOverflowEngine,
  wikipediaEngine,
} from "./direct-engines.js";
import { createDirectGet, type DirectGet } from "./direct-http.js";
import { DEFAULT_ENGINES, DEFAULT_LANGUAGES, engineHosts } from "./engines.js";
import { braveEngine, type SearchKeys, tavilyEngine } from "./general-engines.js";
import { createStdioReaderClient, type StdioReaderClient } from "./stdio-client.js";
import { REPOSITORY_URL, userAgent, WEB_VERSION } from "./user-agent.js";

export const READER_CONTAINER = "suup-reader";
export const READER_IMAGE = "suup-reader:dev";

export interface WebServicesOptions {
  dockerPath?: string;
  engines?: readonly string[];
  languages?: readonly string[];
  searchEnabled?: boolean;
  /** Where the engines with a key find it (environment, then vault). Without it those engines have no key. */
  keys?: SearchKeys;
  readerEnabled?: boolean;
  readerImage?: string;
  readerContainer?: string;
  /** Let the reader render pages with JavaScript (needs Chromium in the image). Default true. */
  render?: boolean;
  /** Where the user agent points (the project page). */
  repositoryUrl?: string;
  /** Test seam: the request the engines use (default: through a loopback egress proxy with their exact hosts). */
  directGet?: DirectGet;
  log?: (message: string) => void;
}

export interface WebServices {
  /** Why no engine could be started, when that is so (the tools say it to the model). */
  searchProblem?: string;
  /** The engines Suup asks itself through their official APIs (docs/BUSCA.md); empty when none is on. */
  direct: DirectEngine[];
  /** Where the loopback egress proxy of the engines listens (for the doctor and the tests). */
  directProxy?: { host: string; port: number };
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
    direct: [],
    engines,
    reader: undefined,
    async stop() {
      for (const stop of stoppers.splice(0)) await stop().catch(() => undefined);
    },
  };

  // The engines need no Docker: they go out through an egress proxy of this process (loopback
  // only) that lets through just their exact hosts.
  if (options.searchEnabled !== false && engines.length > 0) {
    try {
      const started = await startDirect({ ...options, languages }, engines);
      result.direct = started.engines;
      if (started.proxy !== undefined) result.directProxy = started.proxy;
      stoppers.push(started.stop);
    } catch (error) {
      result.searchProblem = error instanceof Error ? error.message : String(error);
      log(`search engines unavailable: ${result.searchProblem}`);
    }
  }
  if (options.readerEnabled !== false) {
    if (!(await dockerAvailable(path))) {
      result.readerProblem = "Docker is not available on this computer";
      return result;
    }
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
  const keys: SearchKeys = options.keys ?? { get: async () => undefined };
  const engines: DirectEngine[] = [];
  for (const id of ids) {
    if (id === "wikipedia") engines.push(wikipediaEngine({ get, languages: options.languages }));
    else if (id === "arxiv") engines.push(arxivEngine({ get }));
    else if (id === "stackoverflow") engines.push(stackOverflowEngine({ get }));
    else if (id === "tavily") engines.push(tavilyEngine({ get, keys }));
    else if (id === "brave") engines.push(braveEngine({ get, keys }));
  }
  return { engines, proxy: proxyAddress, stop };
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
