// Owns the Docker network the bots' machines live on: an INTERNAL bridge, which has no route to
// the outside (no masquerade, forwarding dropped), so a container on it can reach only the host's
// own address on that bridge, where the egress proxy listens. Containers cannot reach each other
// either (inter-container communication is off).

import { isIP } from "node:net";
import { dockerClientEnv } from "../docker-executor.js";
import { runProcess } from "../run-process.js";

export interface MachineNetwork {
  name: string;
  /** The host's address on the bridge: where the proxy listens by default (proxy in the worker). */
  gateway: string;
  /** The IPv4 block of the network (`172.20.0.0/16`), or `undefined` when it has none. */
  subnet: string | undefined;
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
  subnet: string | undefined;
  /** Whether containers on it may talk to each other (the bridge option; on by default). */
  icc: boolean;
  attached: number;
}

async function inspect(path: string, name: string): Promise<Inspected | undefined> {
  const r = await docker(path, [
    "network",
    "inspect",
    "--format",
    '{{.Internal}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{len .Containers}} {{range .IPAM.Config}}{{.Gateway}}|{{.Subnet}} {{end}}',
    name,
  ]);
  if (r.code !== 0) return undefined; // `docker network inspect` exits non-zero when it does not exist
  // Fields are separated by one space; an empty option value is an empty field (same positions).
  const fields = r.stdout.trim().split(" ");
  const [internal, icc, count] = fields;
  const configs = fields.slice(3).filter((f) => f.includes("|"));
  let gateway: string | undefined;
  let subnet: string | undefined;
  for (const entry of configs) {
    const bar = entry.indexOf("|");
    const g = entry.slice(0, bar);
    const sub = entry.slice(bar + 1);
    if (gateway === undefined && g !== "") gateway = g;
    if (subnet === undefined && isIP(sub.slice(0, Math.max(0, sub.indexOf("/")))) === 4) {
      subnet = sub;
    }
  }
  return {
    internal: internal === "true",
    gateway,
    subnet,
    icc: icc !== "false",
    attached: Number(count ?? 0),
  };
}

export interface EnsureNetworkOptions {
  dockerPath?: string;
  /**
   * Whether containers on the network may reach each other. Default `false`: the proxy is on the
   * host's side of the bridge and the machines have nobody to talk to. With the proxy in a
   * CONTAINER of the same network it must be `true` (the machines reach the proxy through the bridge).
   */
  icc?: boolean;
}

/**
 * Makes sure the internal network exists (creates it if absent) and returns its gateway. A network
 * of that name that is NOT internal is refused: it would give the machines a way out.
 */
export async function ensureInternalNetwork(
  name: string,
  options: EnsureNetworkOptions = {},
): Promise<MachineNetwork> {
  const path = options.dockerPath ?? "docker";
  const icc = options.icc ?? false;
  let found = await inspect(path, name);
  if (found?.internal && found.icc !== icc) {
    // Made for the other arrangement (a previous version of the app): it can only change when empty.
    if (found.attached > 0) {
      throw new Error(
        `the Docker network "${name}" was created with inter-container traffic ${found.icc ? "on" : "off"} and has containers attached; remove them (docker rm -f) and the network, or choose another name`,
      );
    }
    await docker(path, ["network", "rm", name]);
    found = await inspect(path, name);
  }
  if (found === undefined) {
    const made = await docker(path, [
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      ...(icc ? [] : ["--opt", "com.docker.network.bridge.enable_icc=false"]),
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
  return { name, gateway: found.gateway, subnet: found.subnet };
}

/**
 * The ordinary (NOT internal) bridge network the egress container also joins, which is its way to
 * the internet. A network of that name that is internal is refused: the proxy would have no way out.
 */
export async function ensureOutNetwork(
  name: string,
  options: { dockerPath?: string } = {},
): Promise<void> {
  const path = options.dockerPath ?? "docker";
  let found = await inspect(path, name);
  if (found === undefined) {
    const made = await docker(path, [
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      "suup.managed=1",
      name,
    ]);
    found = await inspect(path, name);
    if (found === undefined) {
      throw new Error(`docker network create failed (exit ${made.code}): ${made.stderr.trim()}`);
    }
  }
  if (found.internal) {
    throw new Error(
      `the Docker network "${name}" is internal: the egress proxy needs an ordinary network to reach the internet. Remove it or choose another name.`,
    );
  }
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
