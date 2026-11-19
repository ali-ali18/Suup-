import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertExtraCaBundle,
  ContainerStdioLauncher,
  EXTRA_CA_CONTAINER_PATH,
  EXTRA_CA_ENV,
  ensureInternalNetwork,
  ensureMachine,
  extraCaMountArgs,
  removeMachine,
} from "../src/index.js";
import { runProcess } from "../src/run-process.js";

// The optional extra CA bundle (docs/REDE.md): off by default, a read-only mount when configured.
const dir = mkdtempSync(join(tmpdir(), "suup-extra-ca-"));
const bundle = join(dir, "corp-ca.pem");
const PEM = "-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----\n";
writeFileSync(bundle, PEM);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the extra CA bundle: arguments and validation (no Docker)", () => {
  it("is off by default: nothing is mounted and no variable is set", () => {
    expect(extraCaMountArgs(undefined)).toEqual([]);
    const launcher = new ContainerStdioLauncher({
      image: "runner:test",
      network: "net-test",
      egress: { open: () => ({}) as never, envFor: () => ({}) },
    });
    const { args, env } = launcher.wrap({
      connector: "c",
      command: "node",
      args: [],
      env: {},
      egressHosts: [],
    });
    expect(args.join(" ")).not.toContain("extra-ca");
    expect(args).not.toContain("--mount");
    for (const key of Object.keys(EXTRA_CA_ENV)) expect(env[key]).toBeUndefined();
  });

  it("mounts the file read-only in a connector container and sets the variables", () => {
    const launcher = new ContainerStdioLauncher({
      image: "runner:test",
      network: "net-test",
      egress: { open: () => ({}) as never, envFor: () => ({}) },
      extraCaBundle: bundle,
    });
    const { args, env } = launcher.wrap({
      connector: "c",
      command: "node",
      args: [],
      env: { SSL_CERT_FILE: "/own.pem" },
      egressHosts: [],
    });
    const mount = args[args.indexOf("--mount") + 1];
    expect(mount).toBe(`type=bind,source=${bundle},target=${EXTRA_CA_CONTAINER_PATH},readonly`);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(EXTRA_CA_CONTAINER_PATH);
    // What the connector declares itself wins.
    expect(env.SSL_CERT_FILE).toBe("/own.pem");
    // The path of the container is not a secret, and it travels by name like the other variables.
    expect(args).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("refuses a relative path, a missing file, a directory and a comma", () => {
    expect(() => assertExtraCaBundle("corp.pem")).toThrow("absolute");
    expect(() => assertExtraCaBundle(join(dir, "nope.pem"))).toThrow("does not exist");
    expect(() => assertExtraCaBundle(dir)).toThrow("not a file");
    expect(() => assertExtraCaBundle(join(dir, "a,b.pem"))).toThrow("comma");
    expect(() => assertExtraCaBundle(bundle)).not.toThrow();
  });
});

const REAL = process.env.SUUP_DOCKER_TESTS === "1";
const IMAGE = process.env.SUUP_SANDBOX_IMAGE;
const docker = (args: string[]) =>
  runProcess("docker", args, {
    env: process.env as Record<string, string>,
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
    killGroup: false,
  });
const out = (r: { stdout: Buffer }) => r.stdout.toString("utf8");

describe.skipIf(!REAL || IMAGE === undefined)("the extra CA bundle, real Docker", () => {
  const tag = randomBytes(4).toString("hex");
  const name = `suup-catest-${tag}`;
  const volume = `suup-catest-vol-${tag}`;
  const networkName = `suup-catest-${tag}`;

  beforeAll(async () => {
    await ensureInternalNetwork(networkName);
  }, 60_000);
  afterAll(async () => {
    await removeMachine(name, { volume });
    await docker(["network", "rm", networkName]);
  }, 60_000);

  const start = (extraCaBundle?: string) =>
    ensureMachine({
      name,
      image: IMAGE as string,
      volume,
      network: networkName,
      ...(extraCaBundle === undefined ? {} : { extraCaBundle }),
    });

  it("without the setting the machine has no bundle and no variable", async () => {
    await start();
    const listed = await docker(["exec", name, "sh", "-c", `ls ${EXTRA_CA_CONTAINER_PATH}`]);
    expect(listed.exitCode).not.toBe(0);
    const env = out(await docker(["exec", name, "env"]));
    expect(env).not.toContain("NODE_EXTRA_CA_CERTS");
  }, 120_000);

  it("with it the file is there, read-only, with the variables; removing it recreates the machine", async () => {
    await start(bundle);
    expect(out(await docker(["exec", name, "cat", EXTRA_CA_CONTAINER_PATH]))).toBe(PEM);
    const env = out(await docker(["exec", name, "env"]));
    for (const [key, value] of Object.entries(EXTRA_CA_ENV))
      expect(env).toContain(`${key}=${value}`);
    const write = await docker(["exec", name, "sh", "-c", `echo x >> ${EXTRA_CA_CONTAINER_PATH}`]);
    expect(write.exitCode).not.toBe(0);
    // The workspace survives the recreation.
    await docker(["exec", name, "sh", "-c", "echo kept > /workspace/marker"]);
    await start();
    expect(
      (await docker(["exec", name, "sh", "-c", `ls ${EXTRA_CA_CONTAINER_PATH}`])).exitCode,
    ).not.toBe(0);
    expect(out(await docker(["exec", name, "cat", "/workspace/marker"])).trim()).toBe("kept");
  }, 180_000);

  it("a connector container gets the same read-only file", async () => {
    const launcher = new ContainerStdioLauncher({
      image: process.env.SUUP_CONNECTOR_IMAGE ?? (IMAGE as string),
      network: networkName,
      egress: { open: () => ({}) as never, envFor: () => ({}) },
      extraCaBundle: bundle,
    });
    const wrapped = launcher.wrap({
      connector: "catest",
      command: "cat",
      args: [EXTRA_CA_CONTAINER_PATH],
      env: {},
      egressHosts: [],
    });
    const ran = await runProcess(wrapped.command, wrapped.args, {
      env: { ...process.env, ...wrapped.env } as Record<string, string>,
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      killGroup: false,
    });
    expect(out(ran)).toBe(PEM);
  }, 120_000);
});
