// Owns the Docker network the bots' machines live on: an INTERNAL bridge, which has no route to
// the outside (no masquerade, forwarding dropped), so a container on it can reach only the host's
// own address on that bridge, where the egress proxy listens. Containers cannot reach each other
// either (inter-container communication is off).

import { dockerClientEnv } from "../docker-executor.js";
import { runProcess } from "../run-process.js";

export interface MachineNetwork {
  name: string;
  /** The host's address on the bridge: where the proxy listens by default. */
  gateway: string;
}

async function docker(
  path: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runProcess(path, args, {
    env: dockerClientEnv(),
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
    killGroup: false,
  });
  if (r.spawnError !== undefined)
    throw new Error(`could not run "${path}": ${r.spawnError.message}`);
  return { code: r.exitCode, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}

interface Inspected {
  internal: boolean;
  gateway: string | undefined;
}

async function inspect(path: string, name: string): Promise<Inspected | undefined> {
  const r = await docker(path, [
    "network",
    "inspect",
    "--format",
    "{{.Internal}} {{range .IPAM.Config}}{{.Gateway}} {{end}}",
    name,
  ]);
  if (r.code !== 0) return undefined; // `docker network inspect` exits non-zero when it does not exist
  const [internal, gateway] = r.stdout.trim().split(" ");
  return { internal: internal === "true", gateway: gateway === "" ? undefined : gateway };
}

/**
 * Makes sure the internal network exists (creates it if absent) and returns its gateway. A network
 * of that name that is NOT internal is refused: it would give the machines a way out.
 */
export async function ensureInternalNetwork(
  name: string,
  options: { dockerPath?: string } = {},
): Promise<MachineNetwork> {
  const path = options.dockerPath ?? "docker";
  let found = await inspect(path, name);
  if (found === undefined) {
    const made = await docker(path, [
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      "--label",
      "suup.managed=1",
      name,
    ]);
    if (made.code !== 0) {
      found = await inspect(path, name); // a concurrent process may have created it
      if (found === undefined) {
        throw new Error(`docker network create failed (exit ${made.code}): ${made.stderr.trim()}`);
      }
    } else {
      found = await inspect(path, name);
    }
  }
  if (found === undefined) throw new Error(`network ${name} not found after creating it`);
  if (!found.internal) {
    throw new Error(
      `the Docker network "${name}" exists but is not internal: containers on it would have a direct route out. Remove it or choose another name.`,
    );
  }
  if (found.gateway === undefined)
    throw new Error(`the Docker network "${name}" has no gateway address`);
  return { name, gateway: found.gateway };
}

/** The networks a container is attached to (empty when it does not exist). */
export async function containerNetworks(
  container: string,
  options: { dockerPath?: string } = {},
): Promise<string[]> {
  const r = await docker(options.dockerPath ?? "docker", [
    "inspect",
    "--type",
    "container",
    "--format",
    "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
    container,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .trim()
    .split(" ")
    .filter((n) => n !== "");
}
