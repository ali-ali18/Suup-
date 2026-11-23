import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (path: string) => fileURLToPath(new URL(`./${path}`, import.meta.url));

/**
 * Tests run against the SOURCES of the workspace packages, so `pnpm test` on a clean clone does not
 * depend on a previous `tsc -b`. The aliases are read from each package's own `exports` (every
 * subpath, `./answers`, `./testing/store-contract`...), so a new subpath cannot be forgotten here:
 * `./dist/x.js` is `./src/x.ts`. A string alias matches the name and its `/` subpaths, so the
 * longer names come first.
 */
export function workspaceAliases(): { find: string; replacement: string }[] {
  const dirs = [
    ...readdirSync(root("packages")).map((name) => `packages/${name}`),
    "apps/cli",
    "evals",
  ];
  const out: { find: string; replacement: string }[] = [];
  for (const dir of dirs) {
    let manifest: { name?: string; exports?: Record<string, { default?: string }> };
    try {
      manifest = JSON.parse(readFileSync(root(`${dir}/package.json`), "utf8"));
    } catch {
      continue;
    }
    if (manifest.name === undefined || manifest.exports === undefined) continue;
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const built = target.default;
      if (built === undefined || !built.startsWith("./dist/") || !built.endsWith(".js")) continue;
      const source = `./src/${built.slice("./dist/".length, -".js".length)}.ts`;
      out.push({
        find: subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
        replacement: root(`${dir}/${source.slice(2)}`),
      });
    }
  }
  return out.sort((a, b) => b.find.length - a.find.length || a.find.localeCompare(b.find));
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: workspaceAliases() },
        test: {
          name: "node",
          include: [
            "packages/**/*.test.ts",
            "apps/cli/**/*.test.ts",
            "apps/sidecar/**/*.test.ts",
            "evals/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
      // The desktop app has its own project: jsdom, React, and the browser-side aliases.
      "apps/desktop",
    ],
  },
});
