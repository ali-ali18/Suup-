// Owns the shared vocabulary of the loop: the public configuration types (`BotConfig`, `LoopDeps`,
// `RunLoopOptions`, `ToolInvoker`), the `LoopContext` object every loop module receives instead of
// a long parameter list, and the `Interrupted` signal used to unwind on a hard interruption.
import type { Provider, ToolSpec } from "../provider.js";
import type { InvokeOptions, ToolInvocation } from "../registry.js";
import type { Executor, ToolContext } from "../tool.js";
import type { ModelPricing, ReviewerConfig } from "./reviewer.js";
import type { RunState } from "./state.js";
import type { RunRecord, RunStore } from "./store.js";

export interface BotConfig {
  id: string;
  name: string;
  personality: string;
  model: {
    id: string;
    contextWindow: number;
    maxOutputTokens: number;
    pricing?: ModelPricing;
  };
  /** Names of registry tools the bot may use. The control tools are always available. */
  allowedTools: string[];
  limits: { maxTurns: number; maxCostUsd?: number; maxDurationMs?: number };
}

/** The part of `ToolRegistry` the loop needs, so a replay invoker can stand in for it. */
export interface ToolInvoker {
  specs(allowed?: string[]): ToolSpec[];
  invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    opts?: InvokeOptions,
  ): Promise<ToolInvocation>;
}

export interface LoopDeps {
  store: RunStore;
  provider: Provider;
  tools: ToolInvoker;
  executor: Executor;
  bot: BotConfig;
  /** When absent, `finish` is validated by the harness only. */
  reviewer?: ReviewerConfig;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RunLoopOptions {
  /**
   * Hard interruption. Aborting cancels the model call in flight and the tool in flight, and the
   * calls not started yet get an "interrupted" result, so the conversation stays valid. The loop
   * then returns `running`: the run is NOT marked cancelled or failed. What happens next is up to
   * the caller (the worker): put the run back in the queue to resume it, or cancel it.
   */
  signal?: AbortSignal;
  /**
   * Soft stop. Once raised, the loop finishes the turn it is in (the model call and every tool
   * call it asked for, none of them is cancelled) and, at the next safe point, returns `running`
   * WITHOUT starting another model call. A run that finishes or pauses for the user during that
   * last turn settles normally instead. Like `signal`, the run is left as it is: the caller puts
   * it back in the queue to resume it later from the log.
   */
  pauseSignal?: AbortSignal;
}

/**
 * Everything one `runLoop` invocation shares across its modules. `state` is the in-memory fold of
 * the event log (kept in step by `record`) and `run` the last store row read; both are replaced
 * in place as the loop goes, which is why they are mutable fields and not parameters.
 */
export interface LoopContext {
  readonly deps: LoopDeps;
  readonly runId: string;
  readonly signal: AbortSignal | undefined;
  readonly pauseSignal: AbortSignal | undefined;
  /** The signal handed to tools: the caller's, or one that never fires. */
  readonly toolSignal: AbortSignal;
  state: RunState;
  run: RunRecord;
}

export class Interrupted extends Error {
  override readonly name = "Interrupted";
}
