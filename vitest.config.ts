import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string, file = "index.ts") =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          // Tests run against the sources of the workspace packages, so `pnpm test` does not
          // depend on a previous build of `dist`.
          alias: [
            { find: /^@suup\/core\/testing$/, replacement: src("core", "testing/index.ts") },
            {
              find: /^@suup\/core\/testing\/store-contract$/,
              replacement: src("core", "testing/store-contract.ts"),
            },
            {
              find: /^@suup\/connectors\/testing$/,
              replacement: src("connectors", "testing/index.ts"),
            },
            { find: /^@suup\/web\/engines$/, replacement: src("web", "engines.ts") },
            {
              find: /^@suup\/(core|providers|tools|connectors|db|sandbox|web|runtime|api|server)$/,
              replacement: src("$1"),
            },
            {
              find: /^@suup\/cli$/,
              replacement: fileURLToPath(new URL("./apps/cli/src/index.ts", import.meta.url)),
            },
            {
              find: /^@suup\/evals$/,
              replacement: fileURLToPath(new URL("./evals/src/index.ts", import.meta.url)),
            },
          ],
        },
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
