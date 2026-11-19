// Owns what runs INSIDE the egress container: the same proxy as in the worker (`proxy.ts`), with
// the allowlists coming from the worker through the control channel (`control.ts`). It has no
// database, no policy of its own and no secret of the vault; its only inputs are the environment
// the worker gave it at start (two random values) and the worker's answers.
import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { ControlServer } from "./control.js";
import { EgressProxy } from "./proxy.js";

export const EGRESS_PROXY_PORT = 3128;
export const EGRESS_CONTROL_PORT = 3129;

/** The environment variables of the container (names only here; the values come from the worker). */
export const EGRESS_ENV = {
  controlToken: "SUUP_EGRESS_CONTROL_TOKEN",
  secret: "SUUP_EGRESS_SECRET",
  internalSubnet: "SUUP_EGRESS_INTERNAL_SUBNET",
  ports: "SUUP_EGRESS_PORTS",
} as const;

function ipv4ToNumber(text: string): number | undefined {
  if (isIP(text) !== 4) return undefined;
  let n = 0;
  for (const part of text.split(".")) n = n * 256 + Number(part);
  return n;
}

/** Whether the IPv4 address is inside the CIDR block (`172.20.0.0/16`). Numeric, no patterns. */
export function inSubnet(address: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 1) return false;
  const base = ipv4ToNumber(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  const ip = ipv4ToNumber(address);
  if (base === undefined || ip === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(base / size);
}

/**
 * Which address of this container is on the bots' internal network (where the proxy listens, so the
 * bots reach it) and which is on the other, ordinary network (where the control port listens: the
 * bots' network never sees it). Throws when the container does not have both.
 */
export function chooseAddresses(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  internalSubnet: string,
): { proxyHost: string; controlHost: string } {
  let proxyHost: string | undefined;
  let controlHost: string | undefined;
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (inSubnet(info.address, internalSubnet)) proxyHost ??= info.address;
      else controlHost ??= info.address;
    }
  }
  if (proxyHost === undefined)
    throw new Error(`no address in the internal network ${internalSubnet}`);
  if (controlHost === undefined) throw new Error("no address in the second (ordinary) network");
  return { proxyHost, controlHost };
}

export interface EgressServiceOptions {
  controlToken: string;
  secret: Buffer;
  proxyHost: string;
  controlHost: string;
  /** 0: any free port (tests). */
  proxyPort?: number;
  controlPort?: number;
  ports?: readonly number[];
  log?(text: string): void;
  /** Tests only: where an allowed connection really goes. */
  dial?: ConstructorParameters<typeof EgressProxy>[0]["dial"];
  resolver?: ConstructorParameters<typeof EgressProxy>[0]["resolver"];
  answerTimeoutMs?: number;
  ackTimeoutMs?: number;
  helloTimeoutMs?: number;
}

export interface RunningEgressService {
  proxyPort: number;
  controlPort: number;
  control: ControlServer;
  stop(): Promise<void>;
}

export async function startEgressService(
  options: EgressServiceOptions,
): Promise<RunningEgressService> {
  const control = new ControlServer({
    token: options.controlToken,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: options.answerTimeoutMs }),
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
    ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
  });
  const proxy = new EgressProxy({
    policy: control,
    secret: options.secret,
    listenHost: options.proxyHost,
    listenPort: options.proxyPort ?? EGRESS_PROXY_PORT,
    onEvent: (event) => control.report(event),
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(options.dial === undefined ? {} : { dial: options.dial }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  });
  const controlPort = await control.listen(
    options.controlPort ?? EGRESS_CONTROL_PORT,
    options.controlHost,
  );
  const started = await proxy.start();
  return {
    proxyPort: started.port,
    controlPort,
    control,
    async stop() {
      await proxy.stop();
      await control.close();
    },
  };
}

/** The container's entry: reads the environment, starts, logs one line (no secrets). */
export async function runEgressContainer(
  env: Record<string, string | undefined>,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  log: (text: string) => void,
): Promise<RunningEgressService> {
  const controlToken = env[EGRESS_ENV.controlToken];
  const secretHex = env[EGRESS_ENV.secret];
  const subnet = env[EGRESS_ENV.internalSubnet];
  if (controlToken === undefined || controlToken.length < 32) {
    throw new Error(`${EGRESS_ENV.controlToken} is missing or too short`);
  }
  if (secretHex === undefined || secretHex.length < 32) {
    throw new Error(`${EGRESS_ENV.secret} is missing or too short`);
  }
  if (subnet === undefined) throw new Error(`${EGRESS_ENV.internalSubnet} is missing`);
  const { proxyHost, controlHost } = chooseAddresses(interfaces, subnet);
  const portsText = env[EGRESS_ENV.ports];
  const ports =
    portsText === undefined || portsText === ""
      ? undefined
      : portsText.split(",").map((p) => Number(p));
  if (ports?.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`${EGRESS_ENV.ports} is not a list of ports`);
  }
  const running = await startEgressService({
    controlToken,
    secret: Buffer.from(secretHex, "hex"),
    proxyHost,
    controlHost,
    ...(ports === undefined ? {} : { ports }),
    log,
  });
  log(
    `proxy de saída em ${proxyHost}:${running.proxyPort}, controle em ${controlHost}:${running.controlPort}`,
  );
  return running;
}
