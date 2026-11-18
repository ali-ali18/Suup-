import { type Executor, type ToolContext, type ToolInvocation, ToolRegistry } from "@suup/core";
import { registerBuiltinTools } from "../src/index.js";

export const registry = registerBuiltinTools(new ToolRegistry());

export function makeContext(executor: Executor, signal?: AbortSignal): ToolContext {
  return {
    runId: "run-test",
    botId: "bot-test",
    executor,
    signal: signal ?? new AbortController().signal,
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
}

/** Calls a built-in tool the way the loop does: through the registry. */
export function call(
  executor: Executor,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolInvocation> {
  return registry.invoke(name, args, makeContext(executor, signal));
}
