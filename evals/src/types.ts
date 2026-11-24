import type { Executor, InboxItemInput, RunRecord, StoredEvent, Tool } from "@suup/core";

export const EVAL_CATEGORIES = [
  "code",
  "files",
  "research",
  "long",
  "judgment",
  "safety",
  "simple",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** One verified fact about the outcome of a run. */
export interface EvalCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

/** A file the bot handed to the chat (`send_file` or `create_document`), as it was stored. */
export interface DeliveredFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface VerifyContext {
  /** The bot's workspace after the run. */
  ws: Executor;
  run: RunRecord;
  /** The event log of the run, in order. */
  events: StoredEvent[];
  /** The files the run delivered, in order (empty unless the task sets `deliverFiles`). */
  files?: DeliveredFile[];
}

export interface VerifyResult {
  pass: boolean;
  checks: EvalCheck[];
  /** Things worth recording that are not pass/fail (e.g. whether the model obeyed an injection). */
  observations?: Record<string, string | number | boolean>;
}

/** A message the runner posts to the run while it works. */
export interface InboxScriptItem {
  /**
   * Called with each event as it is appended to the log (and the log so far, the event included).
   * The first time it returns true the item is posted; the loop reads it at its next safe point.
   */
  afterEvent(event: StoredEvent, log: readonly StoredEvent[]): boolean;
  item: InboxItemInput;
}

export interface EvalLimits {
  maxTurns: number;
  maxCostUsd: number;
  maxDurationMs: number;
}

export interface EvalTask {
  /** Stable, lowercase, with hyphens. Used on the command line and in reports. */
  id: string;
  /** Brazilian Portuguese, one line. */
  title: string;
  category: EvalCategory;
  /** What the bot is asked to do. Brazilian Portuguese. */
  objective: string;
  /** Acceptance criteria. Brazilian Portuguese. */
  criteria: string[];
  limits: EvalLimits;
  /** Seeds the bot's workspace. */
  setup(ws: Executor): Promise<void>;
  /** Messages injected while the run works. */
  inboxScript?: InboxScriptItem[];
  /** The status the run must end in: some tasks are passed by escalating. */
  expect: { status: "done" | "waiting_user" };
  /** Checks OUTCOMES (workspace, command exit codes, the event log), never the model's wording. */
  verify(ctx: VerifyContext): Promise<VerifyResult>;
  /** Performs a correct solution directly in the workspace, with no model. */
  reference(ws: Executor): Promise<void>;
  /** Eval-only tools the task needs on top of the built-in ones (registered by the runner). */
  tools?: Tool<unknown>[];
  /**
   * The bot is offered `send_file` and `create_document`, and what it delivers is kept for the
   * verifier (`VerifyContext.files`). An ordinary task has no chat to deliver to, so it has neither.
   */
  deliverFiles?: boolean;
  /**
   * Tools this task takes away from the bot, by name, whatever else offers them (for comparing a
   * dedicated tool with the bot doing the same job by itself). The system prompt follows: it
   * describes only the tools the bot is offered.
   */
  withoutTools?: string[];
}
