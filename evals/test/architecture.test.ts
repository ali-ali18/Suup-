import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

const read = (path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
const suupDeps = (path: string) =>
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .flatMap((field) => Object.keys(read(path)[field] ?? {}))
    .filter((name) => name.startsWith("@suup/"))
    .sort();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("dependency direction", () => {
  it("evals depends on runtime, core and db (and the sandbox only for its tests)", () => {
    const pkg = read("evals/package.json");
    expect(
      Object.keys(pkg.dependencies ?? {})
        .filter((n) => n.startsWith("@suup/"))
        .sort(),
    ).toEqual(["@suup/core", "@suup/db", "@suup/runtime"]);
    expect(Object.keys(pkg.devDependencies ?? {}).filter((n) => n.startsWith("@suup/"))).toEqual([
      "@suup/sandbox",
    ]);
  });

  it("nothing but the CLI depends on evals", () => {
    const packages = readdirSync(join(root, "packages")).map((n) => `packages/${n}/package.json`);
    const apps = readdirSync(join(root, "apps")).map((n) => `apps/${n}/package.json`);
    const dependents = [...packages, ...apps].filter((p) => suupDeps(p).includes("@suup/evals"));
    expect(dependents).toEqual(["apps/cli/package.json"]);
  });

  it("no other package imports @suup/evals in its sources", () => {
    const offenders = ["packages", "apps"].flatMap((dir) =>
      sources(join(root, dir)).filter(
        (file) =>
          /["']@suup\/evals["']/.test(readFileSync(file, "utf8")) && !file.includes("apps/cli/"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the sources of evals do not import the CLI", () => {
    const offenders = sources(join(root, "evals/src")).filter((file) =>
      /@suup\/cli/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
