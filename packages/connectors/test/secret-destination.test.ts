import { type SecretDestination, SecretDestinationRefusedError } from "@suup/core";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError, parseConnectorSpec, secretDestinationOf } from "../src/index.js";
import { startFakeHttpServer } from "../src/testing/index.js";
import { fakeSpec, newManager } from "./kit.js";

const managers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

// KOD-36: the secrets of a connector's own configuration are asked for together with where they
// go, and a refusal is a connection that is never opened.
describe("where a connector's secrets go", () => {
  it("an HTTP connector says the host of its address; a local process says it has none", () => {
    const http = parseConnectorSpec({
      name: "web",
      transport: {
        kind: "http",
        url: "https://MCP.Exemplo.test./mcp",
        headers: { Authorization: { secret: "HTTP_TOKEN", prefix: "Bearer " } },
      },
    });
    expect(secretDestinationOf(http)).toEqual({ kind: "host", host: "mcp.exemplo.test" });
    expect(secretDestinationOf(fakeSpec())).toEqual({ kind: "unbound", reason: "stdio_env" });
  });

  it("a refused secret: the connection is refused with the reason, and the server gets no request", async () => {
    const server = await startFakeHttpServer();
    try {
      const asked: SecretDestination[] = [];
      const manager = newManager({
        resolveSecrets: async (_names, destination) => {
          asked.push(destination);
          throw new SecretDestinationRefusedError(
            "HTTP_TOKEN",
            "localhost",
            "o segredo HTTP_TOKEN só pode ir para api.outro.test, não para localhost",
          );
        },
      });
      managers.push(manager);
      const spec = parseConnectorSpec({
        name: "web",
        transport: {
          kind: "http",
          url: server.url.replace("127.0.0.1", "localhost"),
          headers: { Authorization: { secret: "HTTP_TOKEN", prefix: "Bearer " } },
        },
      });
      const error = (await manager.tools(spec).catch((e: unknown) => e)) as ConnectorError;
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error.message).toContain("a conexão foi recusada");
      expect(error.message).toContain("não para localhost");
      expect(asked).toEqual([{ kind: "host", host: "localhost" }]);
      // Nothing reached the server: not the value, not even a request without it.
      expect(server.authorizations).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
