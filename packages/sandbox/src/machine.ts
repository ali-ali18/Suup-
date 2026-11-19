import { assertName, DEFAULT_USER, DEFAULT_WORKSPACE, dockerClientEnv } from "./docker-executor.js";
import { containerNetworks } from "./egress/network.js";
import { runProcess } from "./run-process.js";

export interface EnsureMachineOptions {
  /** Container name. */
  name: string;
  /** Image to start, e.g. the one built from `docker/sandbox`. */
  image: string;
  /** Named volume mounted at `/workspace`; it outlives the container. */
  volume: string;
  /** Memory limit, e.g. `2g`, `512m`. Default `2g`. Swap is disabled. */
  memory?: string;
  /** CPU limit. Default 2. */
  cpus?: number;
  /** Maximum number of processes. Default 512. */
  pidsLimit?: number;
  /** User the container's main process runs as. Default `bot`. */
  user?: string;
  /**
   * The (internal) Docker network the container joins. With it the machine has no direct network:
   * only the egress proxy is reachable. A container that exists on another network is recreated
   * (the workspace volume is kept). Without it: the default bridge, direct egress (legacy).
   */
  network?: string;
  /** Path of the docker CLI. Default `docker`. */
  dockerPath?: string;
}

export interface EnsureMachineResult {
  /** `true` when a container was created, `false` when one already existed (started if stopped). */
  created: boolean;
}

/**
 * Makes sure the bot machine is running: creates the volume and the container if absent, starts
 * it if stopped, does nothing if it is already running. Safe to call repeatedly and concurrently.
 *
 * The container: `sleep infinity` as the main process under `--init` (reaps zombies), non-root
 * user, all capabilities dropped, `no-new-privileges`, memory/CPU/pids limits, no swap, restart
 * policy `unless-stopped`. Network: the internal one given in `network` (no direct egress; the
 * proxy is the only way out), or the default bridge when none is given.
 */
export async function ensureMachine(options: EnsureMachineOptions): Promise<EnsureMachineResult> {
  const docker = options.dockerPath ?? "docker";
  assertName(options.name, "container name");
  assertName(options.volume, "volume name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-/:@]*$/.test(options.image)) {
    throw new Error(`invalid image reference "${options.image}"`);
  }
  const memory = options.memory ?? "2g";
  if (!/^[1-9][0-9]*[bkmg]?$/i.test(memory)) throw new Error(`invalid memory limit "${memory}"`);
  const cpus = options.cpus ?? 2;
  if (!Number.isFinite(cpus) || cpus <= 0) throw new Error(`invalid cpus "${cpus}"`);
  const pidsLimit = options.pidsLimit ?? 512;
  if (!Number.isInteger(pidsLimit) || pidsLimit <= 0)
    throw new Error(`invalid pidsLimit "${pidsLimit}"`);
  const user = options.user ?? DEFAULT_USER;
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.:-]*$/.test(user)) throw new Error(`invalid user "${user}"`);

  if (options.network !== undefined) assertName(options.network, "network name");

  let state = await inspectRunning(docker, options.name);
  if (state !== "absent" && options.network !== undefined) {
    const attached = await containerNetworks(options.name, { dockerPath: docker });
    if (attached.length !== 1 || attached[0] !== options.network) {
      // Started before the network existed (or on another one): it may have a direct route out.
      await run(docker, ["rm", "--force", options.name]);
      state = "absent";
    }
  }
  if (state === "running") return { created: false };
  if (state === "stopped") {
    await run(docker, ["start", options.name]);
    return { created: false };
  }

  await run(docker, ["volume", "create", options.volume]);
  try {
    await run(docker, [
      "run",
      "--detach",
      "--name",
      options.name,
      "--init",
      "--restart",
      "unless-stopped",
      "--user",
      user,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      memory,
      "--memory-swap",
      memory,
      "--cpus",
      String(cpus),
      "--pids-limit",
      String(pidsLimit),
      ...(options.network === undefined ? [] : ["--network", options.network]),
      "--volume",
      `${options.volume}:${DEFAULT_WORKSPACE}`,
      "--workdir",
      DEFAULT_WORKSPACE,
      options.image,
      "sleep",
      "infinity",
    ]);
  } catch (error) {
    // Lost a race with a concurrent ensureMachine: the container exists now, which is fine.
    const now = await inspectRunning(docker, options.name);
    if (now === "running") return { created: false };
    if (now === "stopped") {
      await run(docker, ["start", options.name]);
      return { created: false };
    }
    throw error;
  }
  return { created: true };
}

/**
 * Stops and removes the container (idempotent). The workspace volume is kept unless `volume` is
 * given: removing it deletes every file the bots made.
 */
export async function removeMachine(
  name: string,
  options: { volume?: string; dockerPath?: string } = {},
): Promise<void> {
  const docker = options.dockerPath ?? "docker";
  assertName(name, "container name");
  const result = await exec(docker, ["rm", "--force", name]);
  if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
    throw new Error(`docker rm failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  if (options.volume !== undefined) {
    assertName(options.volume, "volume name");
    const removed = await exec(docker, ["volume", "rm", "--force", options.volume]);
    if (removed.code !== 0 && !/no such volume/i.test(removed.stderr)) {
      throw new Error(`docker volume rm failed (exit ${removed.code}): ${removed.stderr.trim()}`);
    }
  }
}

async function inspectRunning(
  docker: string,
  name: string,
): Promise<"running" | "stopped" | "absent"> {
  const result = await exec(docker, [
    "inspect",
    "--type",
    "container",
    "--format",
    "{{.State.Running}}",
    name,
  ]);
  if (result.code !== 0) {
    if (/no such (container|object)/i.test(result.stderr)) return "absent";
    throw new Error(`docker inspect failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim() === "true" ? "running" : "stopped";
}

async function run(docker: string, args: string[]): Promise<void> {
  const result = await exec(docker, args);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
}

async function exec(
  docker: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runProcess(docker, args, {
    env: dockerClientEnv(),
    timeoutMs: 120_000,
    maxOutputBytes: 65_536,
    killGroup: false,
  });
  if (result.spawnError !== undefined) {
    throw new Error(`could not run "${docker}": ${result.spawnError.message}`);
  }
  return {
    code: result.timedOut ? null : result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.timedOut ? "timed out" : result.stderr.toString("utf8"),
  };
}
