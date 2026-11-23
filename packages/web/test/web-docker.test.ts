import { randomBytes } from "node:crypto";
import { dockerClientEnv, runProcess } from "@suup/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServices, type WebServices } from "../src/docker-services.js";
import { DEFAULT_ENGINES, searxEngineIds } from "../src/engines.js";
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
    expect(services.direct.map((e) => e.id)).toEqual(["wikipedia", "arxiv", "stackoverflow"]);
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

    it("DuckDuckGo is the only engine the real image loads, with Suup's honest user agent", async () => {
      const out = await docker([
        "exec",
        "--workdir",
        "/usr/local/searxng",
        searchContainer,
        "/usr/local/searxng/.venv/bin/python",
        "-c",
        "from searx import settings, engines; engines.load_engines(settings['engines']); print('UA=' + engines.engines['duckduckgo']._HTTP_User_Agent); print('ENGINES=' + ','.join(sorted(engines.engines)))",
      ]);
      expect(out.code, out.err).toBe(0);
      expect(out.out).toContain("UA=SuupBot/");
      expect(out.out).not.toContain("Mozilla");
      // Only the engines SearXNG asks are loaded there; Wikipedia, arXiv and Stack Overflow are Suup's own.
      expect(out.out).toContain(`ENGINES=${searxEngineIds(DEFAULT_ENGINES).sort().join(",")}`);
    }, 60_000);

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

// The engine proxy in its own container (SUUP_EGRESS_IMAGE, the image of docker/egress): the
// topology of the embedded app on Windows, where this process cannot listen on a Docker network.
// SearXNG reaches it with the credentials of this start, and they open only the engines' hosts.
const EGRESS_IMAGE = process.env.SUUP_EGRESS_IMAGE;
describe.skipIf(!REAL || EGRESS_IMAGE === undefined)(
  "web search with the engine proxy in its own container, real Docker",
  () => {
    const tag = randomBytes(4).toString("hex");
    const searchContainer = `suup-wtest-csearch-${tag}`;
    const proxyContainer = `suup-wtest-cegress-${tag}`;
    const network = `suup-wtest-cnet-${tag}`;
    let services: WebServices;
    const logged: string[] = [];
    const python = (code: string) =>
      docker([
        "exec",
        "--workdir",
        "/usr/local/searxng",
        searchContainer,
        "/usr/local/searxng/.venv/bin/python",
        "-c",
        code,
      ]);
    /** What the HTTP client SearXNG itself uses gets back from the proxy of its settings for `url`. */
    const throughSettingsProxy = (url: string, credentials?: "wrong") =>
      python(
        [
          "import httpx",
          "from searx import settings",
          "proxy = settings['outgoing']['proxies']['all://']",
          ...(credentials === "wrong"
            ? [
                "scheme, rest = proxy.split('://', 1)",
                "proxy = scheme + '://harness.search:0@' + rest.split('@', 1)[1]",
              ]
            : []),
          "try:",
          `    print('STATUS', httpx.get(${JSON.stringify(url)}, proxy=proxy, timeout=8).status_code)`,
          "except httpx.ProxyError as error:",
          "    print('PROXY', error)",
          "except Exception as error:",
          "    print('OTHER', type(error).__name__)",
        ].join("\n"),
      );

    beforeAll(async () => {
      services = await startWebServices({
        engines: ["duckduckgo"],
        languages: ["en"],
        searchContainer,
        searchNetwork: network,
        searchProxy: { mode: "container", image: EGRESS_IMAGE as string, name: proxyContainer },
        readerEnabled: false,
        log: (line) => logged.push(line),
      });
    }, 600_000);

    afterAll(async () => {
      await services?.stop();
      await docker(["rm", "--force", searchContainer]);
      await docker(["rm", "--force", proxyContainer]);
      await docker(["network", "rm", network]);
      await docker(["network", "rm", `${network}-out`]);
    }, 60_000);

    it("starts SearXNG with the proxy container, which publishes only its control port on 127.0.0.1", async () => {
      expect(services.searchProblem).toBeUndefined();
      expect(services.searchBackend).toBeDefined();
      const ports = await docker(["port", proxyContainer]);
      expect(ports.code, ports.err).toBe(0);
      const lines = ports.out.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0]?.startsWith("3129/tcp -> 127.0.0.1:")).toBe(true);
      const nets = await docker([
        "inspect",
        "--format",
        "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
        searchContainer,
      ]);
      expect(nets.out.trim()).toBe(network);
    }, 60_000);

    it("the credentials in SearXNG's settings are accepted and open only the engines' hosts", async () => {
      // A host that is no engine's: the proxy knows who asks (not 407) and refuses it (403).
      const other = await throughSettingsProxy("https://example.com/");
      expect(other.code, other.err).toBe(0);
      expect(other.out).toContain("PROXY");
      expect(other.out).toContain("403");
      // Wrong credentials: 407, whatever the host.
      const wrong = await throughSettingsProxy("https://html.duckduckgo.com/html/", "wrong");
      expect(wrong.code, wrong.err).toBe(0);
      expect(wrong.out).toContain("407");
      expect(logged).toContain("search proxy refused example.com:443 (not_allowed)");
      // The engine's host is on the list: it is let through, or (where this computer has no DNS or
      // no internet) fails after the list was passed, never as "not allowed".
      const engine = await throughSettingsProxy("https://html.duckduckgo.com/html/");
      expect(engine.code, engine.err).toBe(0);
      expect(engine.out).not.toContain("407");
      expect(logged).not.toContain("search proxy refused html.duckduckgo.com:443 (not_allowed)");
    }, 90_000);

    it("a search answers, and the proxy container goes away when the services stop", async () => {
      const web = createWebAccess({
        searchEnabled: true,
        readerEnabled: false,
        services: async () => services,
      });
      const out = await web.search({ query: "linux kernel", limit: 3 });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (out.ok) expect(out.hits.length + out.suspended.length).toBeGreaterThan(0);
      await services.stop();
      const left = await docker(["ps", "--all", "--quiet", "--filter", `name=^${proxyContainer}$`]);
      expect(left.out.trim()).toBe("");
    }, 90_000);
  },
);
