import { randomBytes } from "node:crypto";
import { dockerClientEnv, runProcess } from "@suup/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServices, type WebServices } from "../src/docker-services.js";
import { DEFAULT_ENGINES } from "../src/engines.js";
import { createWebAccess } from "../src/service.js";

// Real Docker (SUUP_DOCKER_TESTS=1): the real SearXNG image (pinned) on its internal network behind
// the engine proxy, and the reader container (SUUP_READER_IMAGE, default suup-reader:dev). The
// engines themselves are the internet: where the computer cannot reach them (a sandboxed agent, an
// offline machine) the search answers with every engine suspended, which is also what must work.
// SUUP_WEB_NETWORK_TESTS=1 adds the tests that need the real internet (reading a public page).
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
  const searchContainer = `suup-wtest-search-${tag}`;
  const readerContainer = `suup-wtest-reader-${tag}`;
  const network = `suup-wtest-net-${tag}`;
  let services: WebServices;
  let web: ReturnType<typeof createWebAccess>;

  beforeAll(async () => {
    services = await startWebServices({
      engines: DEFAULT_ENGINES,
      languages: ["en"],
      searchContainer,
      searchNetwork: network,
      searchProxy: { port: 0 },
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
    await docker(["rm", "--force", searchContainer]);
    await docker(["rm", "--force", readerContainer]);
    await docker(["network", "rm", network]);
  }, 60_000);

  it("started both containers", () => {
    expect(services.searchProblem).toBeUndefined();
    expect(services.readerProblem).toBeUndefined();
    expect(services.searchBackend).toBeDefined();
    expect(services.reader).toBeDefined();
  });

  describe("search", () => {
    it("answers JSON through the container's own API, with the engines asked", async () => {
      const out = await web.search({ query: "linux kernel", limit: 3 });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      expect(out.engines).toEqual([...DEFAULT_ENGINES]);
      // Either the engines answered (internet) or each one is reported as not answering (no internet).
      expect(out.hits.length + out.suspended.length).toBeGreaterThan(0);
      for (const hit of out.hits) expect(hit.url.startsWith("http")).toBe(true);
    }, 90_000);

    it("the container has no route out of its own network", async () => {
      const direct = await docker([
        "exec",
        searchContainer,
        "wget",
        "-q",
        "-T",
        "4",
        "-t",
        "1",
        "-O",
        "-",
        "http://1.1.1.1/",
      ]);
      expect(direct.code).not.toBe(0);
      const dns = await docker([
        "exec",
        searchContainer,
        "wget",
        "-q",
        "-T",
        "4",
        "-t",
        "1",
        "-O",
        "-",
        "http://example.com/",
      ]);
      expect(dns.code).not.toBe(0);
    }, 60_000);

    it("the engine proxy refuses a host that is no engine's, and a private address", async () => {
      const url = services.searchProxyUrl as string;
      for (const target of [
        "http://example.com/",
        "http://169.254.169.254/",
        "http://127.0.0.1/",
      ]) {
        const r = await docker([
          "exec",
          "-e",
          `http_proxy=${url}`,
          "-e",
          `use_proxy=yes`,
          searchContainer,
          "wget",
          "-S",
          "-q",
          "-T",
          "5",
          "-t",
          "1",
          "-O",
          "-",
          target,
        ]);
        expect(r.code, target).not.toBe(0);
        expect(r.err, target).toContain("403");
      }
    }, 60_000);

    it("keeps no secret in its settings, and the secret key is in the environment only", async () => {
      const settings = await docker(["exec", searchContainer, "cat", "/etc/searxng/settings.yml"]);
      expect(settings.out).toContain("- json");
      expect(settings.out.split("\n").some((l) => l.trim().startsWith("secret_key:"))).toBe(false);
      const env = await docker(["inspect", "--format", "{{json .Config.Env}}", searchContainer]);
      expect(env.out).toContain("SEARXNG_SECRET=");
      expect(env.out).not.toContain("ultrasecretkey");
    });
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
