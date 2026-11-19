import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LoopDeps } from "../loop/loop.js";
import { APPROVALS_PROMPT_MARK } from "../loop/prompts.js";
import { allowAllGate, createRig, say } from "../testing/index.js";
import { createToolGate } from "./gate.js";

describe("the gate is required", () => {
  it("a loop built without a gate does not compile", () => {
    // Checked by `pnpm typecheck`: if `gate` became optional again, the directive would be unused.
    const forgotten: LoopDeps = {
      ...createRig({ script: [] }).deps(),
      // @ts-expect-error `gate` is required: unchecked execution must be written out as allowAllGate()
      gate: undefined,
    };
    expect(forgotten.gate).toBeUndefined();
  });

  it("allowAllGate decides nothing and says so (the prompt promises no approvals)", async () => {
    const gate = allowAllGate();
    expect(gate.allowsEverything).toBe(true);
    expect(
      await gate.check({
        runId: "r",
        callId: "c",
        botId: "b",
        name: "anything",
        args: {},
        executor: createRig({ script: [] }).executor,
      }),
    ).toBeNull();

    const open = createRig({ script: [say("hi")] });
    await open.run();
    expect(open.provider.requests[0]?.system).not.toContain(APPROVALS_PROMPT_MARK);

    const real = createRig({ script: [say("hi")] });
    const enforcing = createToolGate({
      tools: real.registry,
      rules: { rulesFor: async () => [] },
      now: () => new Date(),
    });
    expect(enforcing.allowsEverything).toBeUndefined();
    const { runLoop } = await import("../loop/loop.js");
    await runLoop(real.deps({ gate: enforcing }), real.runId);
    expect(real.provider.requests[0]?.system).toContain(APPROVALS_PROMPT_MARK);
  });
});

describe("who may name allowAllGate", () => {
  // Opting out of the approval policy must stay visible: only these places write it down. Anything
  // else (a new package, a new code path) that needs it has to be added here, in review.
  const allowed = new Set([
    "packages/core/src/approvals/gate.ts",
    "packages/core/src/approvals/index.ts",
    "packages/core/src/replay.ts",
    "packages/core/src/testing/index.ts",
    "packages/core/src/testing/loop-kit.ts",
    "packages/runtime/src/runtime.ts",
  ]);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name === "dist") return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") && !/\.test\.ts$/.test(path) ? [path] : [];
    });
  }

  it("is named only by the files above (outside tests)", () => {
    const offenders: string[] = [];
    for (const area of ["packages", "apps/cli/src", "evals/src"]) {
      for (const file of sources(join(root, area))) {
        const rel = relative(root, file);
        if (/\/test\//.test(rel)) continue;
        // Comments may talk about it; only code counts.
        const code = readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
          .join("\n");
        if (code.includes("allowAllGate") && !allowed.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
