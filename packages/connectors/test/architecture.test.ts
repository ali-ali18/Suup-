import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const importsOf = (file: string): string[] =>
  [...read(file).matchAll(/^(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
    (m) => m[1] as string,
  );

describe("where the MCP protocol library lives", () => {
  it("connectors imports only core, the protocol SDK, zod, node built-ins and its own files", () => {
    const files = sources(join(root, "packages/connectors/src"));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      for (const from of importsOf(file.slice(root.length))) {
        const ok =
          from.startsWith(".") ||
          from.startsWith("node:") ||
          from === "@suup/core" ||
          from === "zod" ||
          from.startsWith("@modelcontextprotocol/sdk/");
        expect(ok, `${file} imports ${from}`).toBe(true);
      }
    }
  });

  it("depends on core among the workspace packages, and on nothing that runs the loop", () => {
    const pkg = JSON.parse(read("packages/connectors/package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((n) => n.startsWith("@suup/"))).toEqual([
      "@suup/core",
    ]);
  });

  it("no other package imports the protocol SDK, and core knows nothing of connectors", () => {
    for (const area of ["packages", "apps", "evals"]) {
      for (const file of sources(join(root, area))) {
        const rel = file.slice(root.length);
        if (rel.startsWith("packages/connectors/")) continue;
        const text = readFileSync(file, "utf8");
        expect(text, rel).not.toMatch(/from\s+["']@modelcontextprotocol\//);
        if (rel.startsWith("packages/core/")) expect(text, rel).not.toMatch(/@suup\/connectors/);
      }
    }
  });

  it("a connector tool is declared, never decided: the adapter names no policy, vault or database", () => {
    for (const file of sources(join(root, "packages/connectors/src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /createToolGate|decidePolicy|SecretAccess|createRedactor|@suup\/db|@suup\/runtime/,
      );
    }
  });
});
