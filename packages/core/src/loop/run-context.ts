// Owns the shared vocabulary of the loop: the public configuration types (`BotConfig`, `LoopDeps`,
// `RunLoopOptions`, `ToolInvoker`), the `LoopContext` object every loop module receives instead of
// a long parameter list, and the `Interrupted` signal used to unwind on a hard interruption.
import type { ToolGate } from "../approvals/gate.js";
import type { DocumentMaker } from "../documents.js";
import type {
  ContextItem,
  MachineInfo,
  OpenTaskFact,
  OwnRoutines,
  RecentUserMessage,
  ReceptionKind,
  RoutineRef,
  RoutineRunFacts,
  RunClock,
  SecretInfo,
  SupervisorRole,
  TaskResultFacts,
  TaskRunFacts,
  Teammate,
} from "../events.js";
import type { FileSender } from "../files.js";
import type { Message } from "../messages.js";
import type { Provider, ToolSpec } from "../provider.js";
import type { InvokeOptions, ToolInvocation } from "../registry.js";
import type { SecretAccess } from "../secrets.js";
import type { Executor, MemoryService, NetworkAccess, ToolContext } from "../tool.js";
import type { WebAccess } from "../web.js";
import type { LiveFeed } from "./live.js";
import type { ModelPricing, ReviewerConfig } from "./reviewer.js";
import type { RunState } from "./state.js";
import type { RunRecord, RunStore } from "./store.js";
import type { ToolSearchDeps } from "./tool-search.js";
import type { ProgressJudge, WatchdogConfig } from "./watchdog.js";

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
  limits: { maxTurns: number; maxCostUsd?: number; maxDurationMs?: number; maxReturns?: number };
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
  /**
   * Whether a call that names secrets may go where it is going (the hosts the user declared for each
   * secret). Asked BEFORE the gate, so a call that would be refused never shows a card. The refusal
   * is for the model; `undefined`: nothing against it. `invoke` checks again.
   */
  refuseSecretDestination?(
    name: string,
    rawArgs: unknown,
    access: Pick<SecretAccess, "hostsOf">,
  ): Promise<string | undefined>;
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
  /** When the run started and the user's time zone: taken once, recorded, never recomputed. */
  now?: RunClock;
  /** The name the user chose to be called by, when they said one (read once, recorded). */
  ownerName?: string;
  /** The user's other active bots (name and description). */
  team?: Teammate[];
  /** What the bot's machine is in this run (truthful). */
  machine?: MachineInfo;
  /** Names of the connectors granted to the bot. */
  connectors?: string[];
  /** The run is a reception (the welcome of the bot): which one. */
  reception?: ReceptionKind;
  /** The place of the bot in the team (docs/SUPERVISOR.md). */
  supervisor?: SupervisorRole;
  /** A routine opened this run: what fired it (docs/ROTINAS.md). */
  routine?: RoutineRunFacts;
  /** The routines the messages that opened the run are about (the app's "Editar"; recorded). */
  routineRefs?: RoutineRef[];
  /** The bot's own routines when the run started (a run that may create routines; recorded). */
  ownRoutines?: OwnRoutines;
  /** The run is a task (KOD-68): its name and the user's own words that ground it. */
  task?: TaskRunFacts;
  /** The run is the chat turn that receives the report of a finished task. */
  taskResult?: TaskResultFacts;
  /** The last messages of the user in a chat that may start a task, by id (recorded). */
  recentUserMessages?: RecentUserMessage[];
  /** The tasks of this chat, open and recently ended, by id (a chat run of the user; recorded). */
  openTasks?: OpenTaskFact[];
  /** Compact the history past this share of the context window (the user's setting; recorded). */
  compactionThreshold?: number;
  /** Rules and profile facts left out because they did not fit the size cap (recorded). */
  memoryOmitted?: {
    count: number;
    chars: number;
    limitItems?: number;
    ceilingChars?: number;
    /** Only in a run recorded before the limit was counted in memories (it was in characters). */
    limitChars?: number;
  };
}

/** One call the chat run made before the brake moved its work (from the run's tool log). */
export interface HandoffTrailEntry {
  name: string;
  /** The arguments, canonical JSON, clipped. */
  args: string;
  isError: boolean;
}

/** What the harness hands to the runtime when the brake moves a chat run's work to a task. */
export interface HandoffRequest {
  run: RunRecord;
  trigger: "turns" | "time";
  turns: number;
  elapsedMs: number;
  /** The calls made so far, oldest first: the task must not repeat what already changed things. */
  trail: HandoffTrailEntry[];
}

export type HandoffOutcome =
  | { started: true; taskId: string; title: string }
  | { started: false; reason: string };

export interface HandoffDeps {
  /** Model calls after which the work moves (unset: never by count). */
  atTurns?: number;
  /** Milliseconds of work after which it moves (unset: never by time). */
  atMs?: number;
  /** The tool that opens a task: a run that already called it decided by itself, and stays. */
  taskTool: string;
  start(request: HandoffRequest): Promise<HandoffOutcome>;
}

export interface AskCheckDeps {
  /** The cheap model that lists the asks (configured like the progress judge). */
  judge: ProgressJudge;
  /** The tool that opens a task, named to the model when an ask was left out. */
  taskTool: string;
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
   * The progress watchdog (docs/VIGIA.md): what happens at the step limit and when the run loops.
   * Absent: the defaults (on, no judge model). `enabled: false` brings back the failures.
   */
  watchdog?: Partial<WatchdogConfig>;
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
   * Called just before the history of a run is compacted (before the summarizing model call), so
   * the runtime can queue a background consolidation of the conversation (docs/MEMORIA.md). It
   * must only QUEUE (never wait for a model) and cannot change what the run sees: a failure is
   * ignored. A replay does not set it.
   */
  beforeCompaction?(run: RunRecord): Promise<void>;
  /**
   * The connector tools granted to the bot and how to offer them (all loaded, or searched: see
   * `tool-search.ts`). Decided once, at the start of the run, and recorded as `tool_catalog`; a
   * resumed run reads the log instead. Without it every tool is offered directly. A replay passes
   * `{ replayOf }` with the recorded decision.
   */
  toolSearch?: ToolSearchDeps;
  /** The network access the tools of this run may grant (only after an approved card). */
  networkFor?(run: RunRecord): NetworkAccess;
  /** The web (search and the reader service) the tools of this run may use; see `web.ts`. */
  webFor?(run: RunRecord): WebAccess;
  /** Where the files this run sends to the user go (`send_file`); without it the tool says so. */
  filesFor?(run: RunRecord): FileSender;
  /** Who builds the documents this run makes (`create_document`), with the bot as the author. */
  documentsFor?(run: RunRecord): DocumentMaker;
  /**
   * The run may schedule its own return (`schedule_return`): set for a conversation run of the
   * user, left out for an evaluation (isolated) run. It is also required that the run's origin is
   * `user`. The tool is offered, or not, for the whole run.
   */
  allowReturns?: boolean;
  /**
   * The early brake of a chat run (docs/TAREFAS.md): past `atTurns` model calls or `atMs` of work,
   * a chat run of the user that has not opened a task itself is moved to one by the harness
   * (`start`), and ends with a short message. Set only for a chat run that is offered the task
   * tool; a replay passes what the recording decided.
   */
  handoff?: HandoffDeps;
  /**
   * The check at the end of a chat run that offers tasks: a cheap model lists the user's asks and
   * which were neither answered nor handed to a task; with some left the model is told once.
   */
  askCheck?: AskCheckDeps;
  /**
   * Where the text of the agent's own answer goes while the model writes it (KOD-34). Set only for
   * a conversation run that answers the user (`liveAllowed`); nothing is recorded through it.
   * Never set for the reviewer, the summarizer or the progress check: `callModel` also checks.
   */
  live?: LiveFeed;
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
