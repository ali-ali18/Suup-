import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { ensureInternalNetwork } from "@suup/sandbox";
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

export interface MachineImages {
  sandbox: string;
  connectors: string;
}

/**
 * Decides where the bots run. Docker answers and the images are (or get) ready and the network works:
 * `docker`. Anything else: `local`, with the reason as a code (the app writes the sentence).
 */
export async function chooseIsolation(options: {
  docker: string;
  images: MachineImages;
  networkName: string;
  /** Folders with the Dockerfile of each image. */
  contexts: { sandbox: string; connectors: string };
  /** Called before the (slow) build of an image that is not there yet. */
  onBuild(): void;
  log(text: string): void;
}): Promise<Isolation> {
  const { docker, images, contexts, log } = options;
  if (!(await dockerAvailable(docker))) {
    return { mode: "local", reason: "docker_missing", detail: null };
  }
  try {
    let announced = false;
    for (const [tag, dir] of [
      [images.sandbox, contexts.sandbox],
      [images.connectors, contexts.connectors],
    ] as const) {
      if (await imageExists(docker, tag)) continue;
      if (!announced) {
        options.onBuild();
        announced = true;
      }
      await buildImage(docker, tag, dir, log);
    }
  } catch (error) {
    return { mode: "local", reason: "image_failed", detail: String(error) };
  }
  const gateway = await gatewayReachable(docker, options.networkName);
  if (!gateway.ok) return { mode: "local", reason: gateway.reason, detail: gateway.detail };
  return { mode: "docker", reason: null, detail: null };
}
