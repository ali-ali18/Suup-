import { ToolRegistry } from "@suup/core";
import type { ManagerOptions } from "../src/index.js";
import {
  adaptConnector,
  ConnectorManager,
  type ConnectorSpec,
  parseConnectorSpec,
} from "../src/index.js";
import { fakeServerCommand } from "../src/testing/index.js";

/** A stdio connector pointing at the fake server (`over` replaces any field of it). */
export function fakeSpec(over: Record<string, unknown> = {}): ConnectorSpec {
  const { command, args } = fakeServerCommand();
  const { transport: transportOver, ...rest } = over;
  return parseConnectorSpec({
    name: "fake",
    transport: { kind: "stdio", command, args, env: {}, ...(transportOver as object) },
    ...rest,
  });
}

export function newManager(options: Partial<ManagerOptions> = {}): ConnectorManager {
  return new ConnectorManager({ resolveSecrets: async () => ({}), ...options });
}

/** A registry with the connector's tools (as the runtime builds it for a run). */
export async function registryFor(
  manager: ConnectorManager,
  spec: ConnectorSpec,
): Promise<{
  registry: ToolRegistry;
  names: string[];
  info: ReturnType<typeof adaptConnector>["info"];
}> {
  const adapted = adaptConnector(spec, await manager.tools(spec), manager);
  const registry = new ToolRegistry();
  for (const tool of adapted.tools) registry.register(tool);
  return { registry, names: adapted.tools.map((t) => t.name), info: adapted.info };
}
