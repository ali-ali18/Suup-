import { randomBytes } from "node:crypto";
import { dockerClientEnv, runProcess } from "@suup/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServices, type WebServices } from "../src/docker-services.js";
import { createWebAccess } from "../src/service.js";

// Real Docker (SUUP_DOCKER_TESTS=1): the reader container (SUUP_READER_IMAGE, default
// suup-reader:dev). The search needs no Docker (it is tested in direct-engines.test.ts, with stub
// servers). SUUP_WEB_NETWORK_TESTS=1 adds the tests that need the real internet (reading a public page).
const REAL = process.env.SUUP_DOCKER_TESTS === "1";
const NETWORK = process.env.SUUP_WEB_NETWORK_TESTS === "1";
const READER_IMAGE = process.env.SUUP_READER_IMAGE ?? "suup-reader:dev";

async function docker(args: string[]) {
  const r = await runProcess("docker", args, {
    env: dockerClientEnv(),
    timeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
    killGroup: false,
  });
  return { code: r.exitCode, out: r.stdout.toString("utf8"), err: r.stderr.toString("utf8") };
}

describe.skipIf(!REAL)("web services, real Docker", () => {
  const tag = randomBytes(4).toString("hex");
  const readerContainer = `suup-wtest-reader-${tag}`;
  let services: WebServices;
  let web: ReturnType<typeof createWebAccess>;

  beforeAll(async () => {
    services = await startWebServices({
      engines: ["wikipedia"],
      languages: ["en"],
      readerContainer,
      readerImage: READER_IMAGE,
    });
    web = createWebAccess({
      searchEnabled: true,
      readerEnabled: true,
      services: async () => services,
    });
  }, 600_000);

  afterAll(async () => {
    await services?.stop();
    await docker(["rm", "--force", readerContainer]);
  }, 60_000);

  it("started the reader container and the engines, with no search container", async () => {
    expect(services.searchProblem).toBeUndefined();
    expect(services.readerProblem).toBeUndefined();
    expect(services.direct.map((e) => e.id)).toEqual(["wikipedia"]);
    expect(services.reader).toBeDefined();
    const left = await docker(["ps", "--all", "--quiet", "--filter", "name=searxng"]);
    expect(left.out.trim()).toBe("");
  });

  describe("reader", () => {
    it("is hardened: no published port, no mount, no capability, read-only root", async () => {
      const info = await docker([
        "inspect",
        "--format",
        "{{json .HostConfig.CapDrop}} {{.HostConfig.ReadonlyRootfs}} {{len .Mounts}} {{json .NetworkSettings.Ports}} {{json .HostConfig.SecurityOpt}}",
        readerContainer,
      ]);
      expect(info.out).toContain('["ALL"]');
      expect(info.out).toContain("true 0 {}");
      expect(info.out).toContain("no-new-privileges");
      const env = await docker(["exec", readerContainer, "env"]);
      for (const name of [
        "DATABASE_URL",
        "SUUP_VAULT_KEY",
        "SUUP_SERVER_TOKEN",
        "ANTHROPIC_API_KEY",
      ]) {
        expect(env.out).not.toContain(`${name}=`);
      }
    });

    it("refuses private, loopback, link-local and metadata addresses, and other schemes", async () => {
      for (const url of [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.1/",
        "http://[::1]/",
        "file:///etc/passwd",
        "http://user:pw@example.com/",
      ]) {
        const out = await web.read({ url });
        expect(out, url).toMatchObject({ ok: false });
        expect(["private", "invalid_url"], url).toContain(out.ok ? "" : out.reason);
      }
      const rendered = await web.read({ url: "http://127.0.0.1/", render: true });
      expect(rendered).toMatchObject({ ok: false });
    }, 60_000);

    it.skipIf(!NETWORK)(
      "reads a public page into Markdown (needs the internet)",
      async () => {
        const out = await web.read({ url: "https://example.com/" });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        expect(out.ok && out.page.markdown).toContain("Example Domain");
      },
      60_000,
    );
  });
});
