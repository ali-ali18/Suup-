// Test support for packages that exercise connectors: how to start the fake MCP server as a child
// process. Not used by production code.
import { fileURLToPath } from "node:url";

export {
  type FakeHttpServer,
  type FakeServerOptions,
  INJECTION_TEXT,
  startFakeHttpServer,
} from "./fake-server.js";

/**
 * The command and arguments that start the fake server over stdio. From sources (tests) it is run
 * by Node itself (type stripping); from the built package it is the compiled file.
 */
export function fakeServerCommand(): { command: string; args: string[] } {
  const here = import.meta.url;
  const isTs = here.endsWith(".ts");
  const file = fileURLToPath(new URL(`./fake-server.${isTs ? "ts" : "js"}`, here));
  return {
    command: process.execPath,
    args: [...(isTs ? ["--experimental-strip-types", "--no-warnings"] : []), file],
  };
}
