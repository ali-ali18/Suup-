import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { ConnectorManager, type ConnectorSpec, parseConnectorSpec } from "@suup/connectors";
import {
  ContainerStdioLauncher,
  type EgressContainer,
  type EgressEvent,
  startEgressContainer,
} from "@suup/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFakeServerImage,
  dockerReady,
  EGRESS_IMAGE,
  FAKE_SERVER_PATH,
  removeImage,
  removeNetwork,
} from "./docker-kit.js";

const run = promisify(execFile);

// A stdio connector in a container goes out through the proxy CONTAINER (the Windows app's path):
// the worker (this process) holds the policy and is told every decision through the published
// 127.0.0.1 control port. The internet is the real one.
describe.skipIf(!dockerReady || EGRESS_IMAGE === undefined)(
  "stdio connector through the egress proxy container (real Docker)",
  () => {
    const tag = randomBytes(4).toString("hex");
    const networkName = `suup-connec-${tag}`;
    let image = "";
    let egress: EgressContainer;
    let launcher: ContainerStdioLauncher;
    const events: EgressEvent[] = [];
    const managers: ConnectorManager[] = [];

    beforeAll(async () => {
      image = await buildFakeServerImage();
      egress = await startEgressContainer({
        image: EGRESS_IMAGE as string,
        name: `suup-connec-egress-${tag}`,
        internalNetwork: networkName,
        policy: {
          async allowedHosts(subject) {
            return subject.kind === "connector" ? new Set(["registry.npmjs.org"]) : new Set();
          },
        },
        onEvent: (e) => events.push(e),
      });
      launcher = new ContainerStdioLauncher({ image, network: networkName, egress });
    }, 240_000);

    afterAll(async () => {
      for (const m of managers) await m.close();
      await launcher?.closeAll();
      await egress?.stop();
      await removeImage(image);
      await removeNetwork(networkName);
      await removeNetwork(`${networkName}-out`);
    }, 90_000);

    function spec(): ConnectorSpec {
      return parseConnectorSpec({
        name: "fake",
        transport: { kind: "stdio", command: "node", args: [FAKE_SERVER_PATH], env: {} },
      });
    }

    it("the connector's server starts and answers in its container on the proxy's network", async () => {
      const m = new ConnectorManager({
        resolveSecrets: async () => ({}),
        launcher,
        backoff: { baseMs: 10, maxMs: 50 },
        connectTimeoutMs: 30_000,
      });
      managers.push(m);
      const result = await m.callTool(spec(), "echo", { text: "hi" }, { timeoutMs: 30_000 });
      expect(JSON.stringify(result.result)).toContain("echo: hi");
    }, 90_000);

    it("reaches an allowed host through the proxy container, and is refused for the rest", async () => {
      const probe = (url: string) => {
        const wrapped = launcher.wrap({
          connector: "fake",
          command: "python3",
          args: [
            "-c",
            "import urllib.request,urllib.error,sys\n" +
              "class No(urllib.request.HTTPRedirectHandler):\n  def redirect_request(self,*a,**k): return None\n" +
              "try:\n  print('STATUS', urllib.request.build_opener(No).open(sys.argv[1], timeout=20).status)\n" +
              "except urllib.error.HTTPError as e:\n  print('STATUS', e.code)\n" +
              "except Exception as e:\n  print('ERR', e)",
            url,
          ],
          env: {},
          egressHosts: [],
        });
        return run(wrapped.command, wrapped.args, { env: wrapped.env }).then((r) => r.stdout);
      };
      expect(["STATUS 200", "STATUS 301", "STATUS 308"]).toContain(
        (await probe("http://registry.npmjs.org/")).trim(),
      );
      const refused = await probe("http://denied.example.com/");
      expect(refused).toContain("403");
      expect(events.find((e) => e.host === "denied.example.com")).toMatchObject({
        decision: "refused",
        subject: { kind: "connector", id: "fake" },
      });
      expect(await probe("http://x.registry.npmjs.org/")).toContain("403");
    }, 90_000);
  },
);
