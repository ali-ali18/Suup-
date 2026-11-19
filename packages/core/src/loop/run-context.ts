// Owns the shared vocabulary of the loop: the public configuration types (`BotConfig`, `LoopDeps`,
// `RunLoopOptions`, `ToolInvoker`), the `LoopContext` object every loop module receives instead of
// a long parameter list, and the `Interrupted` signal used to unwind on a hard interruption.
import type { ToolGate } from "../approvals/gate.js";
import type { ContextItem, SecretInfo } from "../events.js";
import type { Message } from "../messages.js";
import type { Provider, ToolSpec } from "../provider.js";
import type { InvokeOptions, ToolInvocation } from "../registry.js";
import type { SecretAccess } from "../secrets.js";
import type { Executor, MemoryService, ToolContext } from "../tool.js";
import type { ModelPricing, ReviewerConfig } from "./reviewer.js";
import type { RunState } from "./state.js";
import type { RunRecord, RunStore } from "./store.js";
import type { ToolSearchDeps } from "./tool-search.js";

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

/**
 * What a run starts with that comes from outside the loop. It is read once, at the start of the
 * run, and recorded as the `context_loaded` event (see `LoopDeps.loadRunContext`).
 */
export interface RunContextSnapshot {
  /** The user's standing rules, in a stable order (they go into the system prompt). */
  rules: ContextItem[];
  /** What is known about the user, in a stable order (system prompt too). */
  profile: ContextItem[];
  /** Earlier turns of the same conversation, text only. Placed before the objective. */
  history: Message[];
  /** Told to the model with the history, e.g. that older messages were left out. */
  historyNote?: string;
  /** The secrets the bot may use: names and what they are for, never values. */
  secrets?: SecretInfo[];
}

export interface LoopDeps {
  store: RunStore;
  provider: Provider;
  tools: ToolInvoker;
  executor: Executor;
  bot: BotConfig;
  /** When absent, `finish` is validated by the harness only. */
  reviewer?: ReviewerConfig;
  /**
   * Loads the context of a run that starts (rules, profile, conversation history). Called at most
   * once per run: the result is recorded as the `context_loaded` event right after `run_started`,
   * and a resumed or replayed run reads that event instead of calling this again. Without it the
   * run has no outside context.
   */
  loadRunContext?(runId: string): Promise<RunContextSnapshot>;
  /**
   * The approval policy (section 4.8): decides, for every tool call, whether it runs, is refused or
   * waits for the user. Required, so a loop built by hand cannot run every call unchecked by
   * forgetting it: running unchecked is `allowAllGate()`, written out (tests, evaluations on a
   * disposable machine, replays of runs recorded without approvals).
   */
  gate: ToolGate;
  /**
   * The vault seam: where `{{secret:NAME}}` placeholders get their values at the moment of the
   * action, and what scrubs known values out of everything the run records or hands to the model.
   * Without it a call that names a secret is refused and nothing is scrubbed.
   */
  secrets?: SecretAccess;
  /** The memory the tools of this run may use. Without it the memory tools report an error. */
  memoryFor?(run: RunRecord): MemoryService;
  /**
   * The connector tools granted to the bot and how to offer them (all loaded, or searched: see
   * `tool-search.ts`). Decided once, at the start of the run, and recorded as `tool_catalog`; a
   * resumed run reads the log instead. Without it every tool is offered directly. A replay passes
   * `{ replayOf }` with the recorded decision.
   */
  toolSearch?: ToolSearchDeps;
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
