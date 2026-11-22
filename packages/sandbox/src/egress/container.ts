// Owns starting the egress proxy as its own container and connecting the worker to it. The
// container joins the bots' INTERNAL network (the machines and connectors reach it there; it is the
// only thing there that can talk to the outside) and an ordinary bridge network (its way out). Its
// control port is published on 127.0.0.1 of the computer ONLY, so a process of the host (the
// Windows app's sidecar, through Docker Desktop's port forwarding) can connect to it and nothing
// else can; inside, that port listens only on the ordinary network's address, never on the bots'.
import { randomBytes } from "node:crypto";
import { assertName, dockerClientEnv } from "../docker-executor.js";
import { runProcess } from "../run-process.js";
import { EGRESS_CONTROL_PORT, EGRESS_ENV, EGRESS_PROXY_PORT } from "./container-service.js";
import { ControlClient } from "./control.js";
import { ensureInternalNetwork, ensureOutNetwork, type MachineNetwork } from "./network.js";
import type { EgressEvent, EgressPolicy, EgressService } from "./types.js";

export const EGRESS_LABEL = "suup.role=egress";
export const DEFAULT_EGRESS_IMAGE = "suup-egress:dev";
export const DEFAULT_EGRESS_NAME = "suup-egress";

export interface EgressContainerOptions {
  /** The image built from `docker/egress`. */
  image?: string;
  /** Container name; one owner at a time (an older container of the name is replaced). */
  name?: string;
  /** The internal network of the machines (the proxy joins it). */
  internalNetwork: string;
  /** The ordinary network the proxy goes out through. Default `<internalNetwork>-out`. */
  outNetwork?: string;
  policy: EgressPolicy;
  onEvent?(event: EgressEvent): void;
  ports?: readonly number[];
  dockerPath?: string;
  log?(text: string): void;
  /** How long to wait for the proxy to come up. Default 30 s. */
  startTimeoutMs?: number;
}

export interface EgressContainer extends EgressService {
  network: MachineNetwork;
  address: { host: string; port: number };
  /** The port of the computer the control channel goes through (127.0.0.1). */
  controlPort: number;
  stop(): Promise<void>;
}

async function docker(
  path: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runProcess(path, args, {
    env: { ...dockerClientEnv(), ...env },
    timeoutMs: 120_000,
    maxOutputBytes: 65_536,
    killGroup: false,
  });
  if (r.spawnError !== undefined) {
    throw new Error(`could not run "${path}": ${r.spawnError.message}`);
  }
  return { code: r.exitCode, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}

async function must(path: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await docker(path, args, env);
  if (r.code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${r.code}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export async function startEgressContainer(
  options: EgressContainerOptions,
): Promise<EgressContainer> {
  const path = options.dockerPath ?? "docker";
  const name = options.name ?? DEFAULT_EGRESS_NAME;
  const image = options.image ?? DEFAULT_EGRESS_IMAGE;
  assertName(name, "container name");
  if (image.includes(" ") || image === "") throw new Error("invalid image");
  const outName = options.outNetwork ?? `${options.internalNetwork}-out`;
  assertName(outName, "network name");

  // The proxy must be reachable by the machines through the bridge: inter-container traffic on.
  const network = await ensureInternalNetwork(options.internalNetwork, {
    dockerPath: path,
    icc: true,
  });
  if (network.subnet === undefined) {
    throw new Error(`the Docker network "${options.internalNetwork}" has no IPv4 block`);
  }
  await ensureOutNetwork(outName, { dockerPath: path });

  // Fresh values for each start: the channel's token and the key of the subjects' credentials.
  const controlToken = randomBytes(32).toString("hex");
  const secret = randomBytes(32);
  // The values reach the container through the docker client's environment, named with `--env NAME`:
  // they never appear in an argument list.
  const passed: Record<string, string> = {
    [EGRESS_ENV.controlToken]: controlToken,
    [EGRESS_ENV.secret]: secret.toString("hex"),
    [EGRESS_ENV.internalSubnet]: network.subnet,
    ...(options.ports === undefined ? {} : { [EGRESS_ENV.ports]: options.ports.join(",") }),
  };

  await docker(path, ["rm", "--force", name]); // an older one (a killed worker), or nothing
  let client: ControlClient | undefined;
  const remove = async (): Promise<void> => {
    client?.stop();
    await docker(path, ["rm", "--force", name]);
  };
  try {
    await must(
      path,
      [
        "create",
        "--name",
        name,
        "--init",
        "--label",
        "suup.managed=1",
        "--label",
        EGRESS_LABEL,
        "--network",
        outName,
        "--publish",
        `127.0.0.1::${EGRESS_CONTROL_PORT}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--user",
        "1000:1000",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        ...Object.keys(passed).flatMap((key) => ["--env", key]),
        image,
      ],
      passed,
    );
    await must(path, ["network", "connect", options.internalNetwork, name]);
    await must(path, ["start", name]);

    const mapped = await must(path, ["port", name, `${EGRESS_CONTROL_PORT}/tcp`]);
    const first = mapped.split("\n")[0] ?? "";
    const controlPort = Number(first.slice(first.lastIndexOf(":") + 1));
    if (!Number.isInteger(controlPort) || controlPort < 1) {
      throw new Error(`could not read the published control port ("${first}")`);
    }
    const ip = await must(path, [
      "inspect",
      "--type",
      "container",
      "--format",
      `{{(index .NetworkSettings.Networks "${options.internalNetwork}").IPAddress}}`,
      name,
    ]);
    if (ip === "") throw new Error("the egress container has no address on the internal network");

    client = new ControlClient({
      host: "127.0.0.1",
      port: controlPort,
      token: controlToken,
      secret,
      advertise: { host: ip, port: EGRESS_PROXY_PORT },
      policy: options.policy,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    try {
      await client.start(options.startTimeoutMs ?? 30_000);
    } catch (error) {
      const logs = await docker(path, ["logs", "--tail", "20", name]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. Registro do contêiner: ${`${logs.stdout}${logs.stderr}`.trim().slice(-600)}`,
      );
    }
    const live = client;
    return {
      network,
      address: { host: ip, port: EGRESS_PROXY_PORT },
      controlPort,
      open: (subject) => live.open(subject),
      envFor: (subject) => live.envFor(subject),
      stop: remove,
    };
  } catch (error) {
    await remove().catch(() => undefined);
    throw error;
  }
}
