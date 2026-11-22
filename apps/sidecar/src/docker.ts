import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { ensureInternalNetwork, startEgressContainer } from "@suup/sandbox";
import type { Isolation } from "./protocol.js";

interface Ran {
  code: number;
  output: string;
}

/**
 * Runs the Docker command line client. It is the same client the bots' machine uses (`docker`, found
 * in the PATH or in `SUUP_DOCKER_PATH`): it picks the daemon by itself (the named pipe of Docker
 * Desktop on Windows, the socket on Linux, `DOCKER_HOST` and the current context when set), so the
 * environment is passed on as it is.
 */
function run(docker: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      docker,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** Docker is installed AND its daemon answers: the exit code of `docker info`, never its text. */
export async function dockerAvailable(docker: string): Promise<boolean> {
  return (await run(docker, ["info"], 20_000)).code === 0;
}

/** Whether the image is in the local store: the exit code of `docker image inspect`. */
export async function imageExists(docker: string, image: string): Promise<boolean> {
  return (await run(docker, ["image", "inspect", image], 20_000)).code === 0;
}

/** Builds an image from a folder with a Dockerfile; the failure carries the end of the output. */
export async function buildImage(
  docker: string,
  tag: string,
  contextDir: string,
  log: (text: string) => void,
): Promise<void> {
  log(`docker build ${tag}`);
  const done = await run(docker, ["build", "--tag", tag, contextDir], 30 * 60_000);
  log(done.output);
  if (done.code !== 0) {
    const tail = done.output.trimEnd().split("\n").slice(-6).join("\n");
    throw new Error(`docker build de ${tag} falhou (código ${done.code}):\n${tail}`);
  }
}

/** Pulls an image from its registry; the failure carries the end of the output. */
export async function pullImage(
  docker: string,
  image: string,
  log: (text: string) => void,
): Promise<void> {
  log(`docker pull ${image}`);
  const done = await run(docker, ["pull", "--quiet", image], 30 * 60_000);
  log(done.output);
  if (done.code !== 0) {
    const tail = done.output.trimEnd().split("\n").slice(-6).join("\n");
    throw new Error(`docker pull de ${image} falhou (código ${done.code}):\n${tail}`);
  }
}

/**
 * The images of the web (docs/BUSCA.md): the page reader, built from the folder the app carries, and
 * the pinned SearXNG, pulled. Neither is needed for the bots' machine, so a failure here only leaves
 * that part of the web off (the tools say it): `web_read` then reads in this process, without
 * `render`, and `web_search` keeps the engines with a public API. Returns what failed, for the log.
 */
export async function prepareWebImages(options: {
  docker: string;
  reader: { image: string; context: string };
  searxng: string;
  onBuild(): void;
  log(text: string): void;
}): Promise<string[]> {
  const { docker, log } = options;
  const failed: string[] = [];
  let announced = false;
  const announce = () => {
    if (!announced) options.onBuild();
    announced = true;
  };
  try {
    if (!(await imageExists(docker, options.reader.image))) {
      announce();
      await buildImage(docker, options.reader.image, options.reader.context, log);
    }
  } catch (error) {
    failed.push(`leitor de páginas: ${String(error)}`);
  }
  try {
    if (!(await imageExists(docker, options.searxng))) {
      announce();
      await pullImage(docker, options.searxng, log);
    }
  } catch (error) {
    failed.push(`busca (SearXNG): ${String(error)}`);
  }
  return failed;
}

/**
 * Whether this computer can serve the bots' internal network. The harness runs the bots' only way out
 * (a proxy with a list of hosts) on THIS computer, listening on the gateway address of that network.
 * With Docker Desktop (Windows, macOS) that address lives inside Docker's virtual machine, and a
 * process outside it cannot listen there: the test is the listen itself, by its error code.
 */
export async function gatewayReachable(
  docker: string,
  networkName: string,
): Promise<
  { ok: true } | { ok: false; reason: "network_failed" | "gateway_unreachable"; detail: string }
> {
  let gateway: string;
  try {
    gateway = (await ensureInternalNetwork(networkName, { dockerPath: docker })).gateway;
  } catch (error) {
    return { ok: false, reason: "network_failed", detail: String(error) };
  }
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) =>
      resolve({
        ok: false,
        reason: "gateway_unreachable",
        detail: `não consegui escutar em ${gateway}: ${error.code ?? error.message}`,
      }),
    );
    probe.listen(0, gateway, () => probe.close(() => resolve({ ok: true })));
  });
}

/**
 * Whether the bots' proxy can run in its own container and be reached by this process: starts it (a
 * throwaway one, with an empty policy) and opens the control channel through the port published on
 * 127.0.0.1. That is the path of Docker Desktop on Windows: the networks live inside Docker's virtual
 * machine, and only published ports are forwarded to the computer.
 */
export async function egressContainerWorks(
  docker: string,
  networkName: string,
  image: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const probe = await startEgressContainer({
      dockerPath: docker,
      image,
      name: "suup-egress-probe",
      internalNetwork: networkName,
      policy: { allowedHosts: async () => new Set() },
      startTimeoutMs: 30_000,
    });
    await probe.stop();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

export interface MachineImages {
  sandbox: string;
  connectors: string;
  egress: string;
}

/** The bots' images and the web's own (the page reader). */
export interface AppImages extends MachineImages {
  reader: string;
}

/** Where the bots' proxy runs: in its own container (works everywhere Docker does), or in this process. */
export type EgressMode = "container" | "process";

/**
 * Decides where the bots run. Docker answers and the images are (or get) ready and the network works:
 * `docker`, with the proxy in a container; failing that, with the proxy in this process (a Linux host
 * can listen on the network's gateway). Anything else: `local`, with the reason as a code (the app
 * writes the sentence).
 */
export async function chooseIsolation(options: {
  docker: string;
  images: MachineImages;
  networkName: string;
  /** Folders with the Dockerfile of each image. */
  contexts: { sandbox: string; connectors: string; egress: string };
  /** Called before the (slow) build of an image that is not there yet. */
  onBuild(): void;
  log(text: string): void;
}): Promise<{ isolation: Isolation; egress: EgressMode | null }> {
  const { docker, images, contexts, log } = options;
  const local = (reason: Isolation["reason"], detail: string | null) => ({
    isolation: { mode: "local", reason, detail } as Isolation,
    egress: null,
  });
  if (!(await dockerAvailable(docker))) return local("docker_missing", null);
  try {
    let announced = false;
    for (const [tag, dir] of [
      [images.sandbox, contexts.sandbox],
      [images.connectors, contexts.connectors],
      [images.egress, contexts.egress],
    ] as const) {
      if (await imageExists(docker, tag)) continue;
      if (!announced) {
        options.onBuild();
        announced = true;
      }
      await buildImage(docker, tag, dir, log);
    }
  } catch (error) {
    return local("image_failed", String(error));
  }
  const contained = await egressContainerWorks(docker, options.networkName, images.egress);
  if (contained.ok) {
    return { isolation: { mode: "docker", reason: null, detail: null }, egress: "container" };
  }
  log(`proxy de saída em contêiner indisponível: ${contained.detail}`);
  // Last resort: the proxy in this process, on the gateway of the internal network.
  const gateway = await gatewayReachable(docker, options.networkName);
  if (gateway.ok) {
    return { isolation: { mode: "docker", reason: null, detail: null }, egress: "process" };
  }
  return local(
    gateway.reason,
    `${gateway.detail}; proxy em contêiner: ${contained.detail}`.slice(0, 1500),
  );
}
