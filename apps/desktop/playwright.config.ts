import { defineConfig } from "@playwright/test";

// End-to-end tests against a REAL server (see e2e/harness.ts). The browser is Chromium; in a
// sandbox that has one preinstalled, point SUUP_CHROMIUM at its binary instead of installing.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  // One schema and one server per file; the files share a database, so run them one by one.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Generous: CI machines are several times slower than a developer's.
  timeout: 180_000,
  expect: { timeout: 45_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "pt-BR",
    trace: "off",
    video: "off",
    screenshot: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: {
      ...(process.env.SUUP_CHROMIUM ? { executablePath: process.env.SUUP_CHROMIUM } : {}),
      args: ["--no-sandbox"],
    },
  },
});
