import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DockerExecutor,
  EgressProxy,
  type EgressSubject,
  ensureInternalNetwork,
  ensureMachine,
  NetworkedExecutor,
  removeMachine,
} from "../src/index.js";
import { runProcess } from "../src/run-process.js";

// The bots' machine as it is shipped (docker/sandbox/Dockerfile): the tools for documents are there,
// and `pip` installs from PyPI THROUGH the egress proxy (docs/REDE.md: pypi.org and
// files.pythonhosted.org are in the default list). Real Docker and the real PyPI: opt-in with
// SUUP_DOCKER_TESTS=1, SUUP_SANDBOX_IMAGE and SUUP_PIP_TESTS=1 (it needs the internet). Behind a
// network that re-signs HTTPS, SUUP_EXTRA_CA_BUNDLE names its CA file, mounted the way
// `sandbox.extraCaBundle` is (docs/REDE.md, "Rede com interceptação de TLS").
const REAL = process.env.SUUP_DOCKER_TESTS === "1" && process.env.SUUP_PIP_TESTS === "1";
const IMAGE = process.env.SUUP_SANDBOX_IMAGE;
const BOT: EgressSubject = { kind: "bot", id: "44444444-4444-4444-8444-444444444444" };
const PYPI = ["pypi.org", "files.pythonhosted.org"];
const EXTRA_CA = process.env.SUUP_EXTRA_CA_BUNDLE;

describe.skipIf(!REAL || IMAGE === undefined)("the bots' machine: documents and pip", () => {
  const tag = randomBytes(4).toString("hex");
  const networkName = `suup-piptest-${tag}`;
  const container = `suup-piptest-${tag}`;
  const volume = `suup-piptest-vol-${tag}`;
  let proxy: EgressProxy;
  let machine: NetworkedExecutor;

  beforeAll(async () => {
    const net = await ensureInternalNetwork(networkName);
    proxy = new EgressProxy({
      listenHost: net.gateway,
      policy: { allowedHosts: async () => new Set(PYPI) },
    });
    await proxy.start();
    await ensureMachine({
      name: container,
      image: IMAGE as string,
      volume,
      network: networkName,
      ...(EXTRA_CA === undefined ? {} : { extraCaBundle: EXTRA_CA }),
    });
    machine = new NetworkedExecutor(
      new DockerExecutor({ container, workspace: "/workspace" }),
      proxy,
      BOT,
    );
  }, 120_000);

  afterAll(async () => {
    await proxy?.stop();
    await removeMachine(container, { volume });
    await runProcess("docker", ["network", "rm", networkName], {
      env: process.env as Record<string, string>,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      killGroup: false,
    });
  }, 60_000);

  it("has the document tools: pip, venv, reportlab, python-docx, openpyxl and file", async () => {
    const r = await machine.exec(
      "pip --version && python3 -m venv /tmp/v && python3 -c 'import reportlab, docx, openpyxl; print(\"libs ok\")' && file --version",
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("libs ok");
  }, 60_000);

  it("makes a PDF with reportlab", async () => {
    const r = await machine.exec(
      "python3 -c \"from reportlab.pdfgen import canvas; c = canvas.Canvas('a.pdf'); c.drawString(72, 720, 'Oi'); c.save()\" && file -b --mime-type a.pdf",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("application/pdf");
  }, 60_000);

  it("installs a package from PyPI through the proxy, as the bot's own user", async () => {
    const r = await machine.exec(
      "pip install -q --no-warn-script-location tabulate && python3 -c 'import tabulate; print(tabulate.__file__)'",
      { timeoutMs: 120_000 },
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/home/bot/.local/");
  }, 180_000);

  it("a host off the list is refused, and the result says how to ask for it", async () => {
    const r = await machine.exec(
      "pip download -q --no-deps -i https://example.com/simple tabulate",
      {
        timeoutMs: 60_000,
      },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("host example.com is not allowed for this bot");
    expect(r.stderr).toContain("request_network_access");
  }, 120_000);
});
