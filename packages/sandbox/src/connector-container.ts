// Owns running a stdio MCP server inside a container instead of on the host: how the `docker run`
// is built (argv array, never a shell), what the container gets (only the declared environment and
// the proxy settings; no volume, no host path, no inherited variable), and how it is limited. The
// MCP client speaks to it through the `docker run -i` process's stdin and stdout.
import { randomBytes } from "node:crypto";
import { assertName, dockerClientEnv } from "./docker-executor.js";
import type { EgressService } from "./egress/types.js";
import { runProcess } from "./run-process.js";

export interface ConnectorContainerOptions {
  /** The runner image (docker/connector-runner). */
  image: string;
  /** The internal network (the same as the bots' machines): the proxy is the only way out. */
  network: string;
  egress: EgressService;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  dockerPath?: string;
}

/** The shape `@suup/connectors` expects of a launcher (kept structural: this package does not import it). */
export interface ContainerLauncherInput {
  connector: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  egressHosts: string[];
}

export const CONNECTOR_LABEL = "suup.role=connector";

/** Names that would reconfigure the docker client itself if a connector declared them. */
const RESERVED_PREFIX = "DOCKER_";

export class ContainerStdioLauncher {
  readonly where = "container" as const;
  readonly #o: ConnectorContainerOptions;
  /** The containers THIS process started (several processes may run connectors on one host). */
  readonly #started = new Set<string>();

  constructor(options: ConnectorContainerOptions) {
    this.#o = options;
    assertName(options.network, "network name");
    if (options.image.includes(" ") || options.image === "") throw new Error("invalid image");
  }

  wrap(input: ContainerLauncherInput): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const subject = { kind: "connector" as const, id: input.connector };
    const name = `suup-conn-${input.connector}-${randomBytes(4).toString("hex")}`;
    assertName(name, "container name");
    this.#started.add(name);
    // The values travel in the docker client's own environment and are named with `-e NAME`
    // (no value): they never appear in a process listing's argument list.
    const passed: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (key.toUpperCase().startsWith(RESERVED_PREFIX)) {
        throw new Error(
          `a connector cannot declare ${key}: names starting with ${RESERVED_PREFIX} are reserved`,
        );
      }
      passed[key] = value;
    }
    Object.assign(passed, this.#o.egress.envFor(subject));

    const args = [
      "run",
      "--rm",
      "--interactive",
      "--init",
      "--name",
      name,
      "--label",
      "suup.managed=1",
      "--label",
      CONNECTOR_LABEL,
      "--network",
      this.#o.network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=256m",
      "--tmpfs",
      "/home/runner:rw,exec,nosuid,uid=1000,gid=1000,size=512m",
      "--user",
      "1000:1000",
      "--memory",
      this.#o.memory ?? "512m",
      "--memory-swap",
      this.#o.memory ?? "512m",
      "--cpus",
      String(this.#o.cpus ?? 1),
      "--pids-limit",
      String(this.#o.pidsLimit ?? 256),
      ...Object.keys(passed).flatMap((key) => ["--env", key]),
      this.#o.image,
      input.command,
      ...input.args,
    ];
    const client = dockerClientEnv();
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "HOME",
      "XDG_RUNTIME_DIR",
      "DOCKER_HOST",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
    ]) {
      const value = client[key];
      if (value !== undefined) env[key] = value;
    }
    return { command: this.#o.dockerPath ?? "docker", args, env: { ...env, ...passed } };
  }

  /** Removes the containers this process started and that are still around (shutdown). */
  async closeAll(): Promise<void> {
    const names = [...this.#started];
    this.#started.clear();
    if (names.length === 0) return;
    await runProcess(this.#o.dockerPath ?? "docker", ["rm", "--force", ...names], {
      env: dockerClientEnv(),
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      killGroup: false,
    });
  }

  /** Removes connector containers left behind (a killed worker). Returns how many. */
  async removeLeftovers(): Promise<number> {
    const docker = this.#o.dockerPath ?? "docker";
    const listed = await runProcess(
      docker,
      ["ps", "--all", "--quiet", "--filter", `label=${CONNECTOR_LABEL}`],
      {
        env: dockerClientEnv(),
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        killGroup: false,
      },
    );
    const ids = listed.stdout
      .toString("utf8")
      .split("\n")
      .filter((l) => l !== "");
    if (ids.length === 0) return 0;
    await runProcess(docker, ["rm", "--force", ...ids], {
      env: dockerClientEnv(),
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      killGroup: false,
    });
    return ids.length;
  }
}
