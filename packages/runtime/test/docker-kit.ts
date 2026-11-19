// Helpers of the tests that need a real Docker daemon: the flag, the images, and the image of the
// fake MCP server (the connector runner image plus the built fake server and its dependencies).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DOCKER = process.env.SUUP_DOCKER_TESTS === "1";
export const SANDBOX_IMAGE = process.env.SUUP_SANDBOX_IMAGE;
/** The runner image of the connectors (built from docker/connector-runner). */
export const RUNNER_IMAGE = process.env.SUUP_CONNECTOR_IMAGE;
export const dockerReady = DOCKER && SANDBOX_IMAGE !== undefined && RUNNER_IMAGE !== undefined;

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** Where the fake MCP server sits inside the test image. */
export const FAKE_SERVER_PATH = "/opt/fake/dist/testing/fake-server.js";

/** Builds `FROM runner` + the fake server with its production dependencies. Returns the image name. */
export async function buildFakeServerImage(): Promise<string> {
  const tag = `suup-fake-mcp-test:${randomBytes(4).toString("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), "suup-fake-image-"));
  try {
    await run(
      "pnpm",
      ["--filter", "@suup/connectors", "deploy", "--legacy", "--prod", join(dir, "fake")],
      {
        cwd: REPO,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "Dockerfile"),
      `FROM ${RUNNER_IMAGE}\nCOPY --chown=1000:1000 fake /opt/fake\n`,
    );
    await run("docker", ["build", "--quiet", "--tag", tag, dir], { maxBuffer: 16 * 1024 * 1024 });
    return tag;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeImage(tag: string): Promise<void> {
  await run("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
}

export async function removeNetwork(name: string): Promise<void> {
  await run("docker", ["network", "rm", name]).catch(() => undefined);
}

export { cp };

/** The image of the egress proxy (built from docker/egress); the tests of the proxy container need it. */
export const EGRESS_IMAGE = process.env.SUUP_EGRESS_IMAGE;
