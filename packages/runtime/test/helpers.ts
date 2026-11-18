import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { RuntimeConfig } from "../src/index.js";

const temps: string[] = [];

/** A fresh temporary directory, removed after the test file. */
export async function tempDir(prefix = "suup-runtime-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A valid configuration as a plain object (the shape of the file), with overrides on top. */
export function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      { id: "anthropic", kind: "anthropic", apiKeyEnv: "KEY_A" },
      { id: "local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" },
      { id: "script", kind: "scripted", scriptPath: "script.json" },
    ],
    models: [
      {
        id: "model-x",
        provider: "anthropic",
        contextWindow: 100000,
        maxOutputTokens: 4096,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
      { id: "model-y", provider: "local", contextWindow: 32000, maxOutputTokens: 2048 },
      { id: "model-s", provider: "script", contextWindow: 100000, maxOutputTokens: 4096 },
    ],
    sandbox: { kind: "local", root: "workspace" },
    ...overrides,
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export type { RuntimeConfig };
