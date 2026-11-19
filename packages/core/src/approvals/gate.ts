// Owns turning a tool call into a verdict: it asks the registry for the call's level and card
// text, loads the user's rules, asks the reviewer, and applies `decidePolicy`. The loop calls it
// and records what it says; replays serve the recorded verdicts instead (`createReplayGate`).
import type { PolicySource, RunEventData } from "../events.js";
import type { JsonValue } from "../messages.js";
import type { OutboundMessage } from "../outbound.js";
import type { AssessOptions, ToolAssessment } from "../registry.js";
import type { RiskLevel } from "../risk.js";
import type { Executor } from "../tool.js";
import { decidePolicy, type PolicyOutcome } from "./decide.js";
import { type AutoReviewer, levelReviewer, type ReviewVerdict } from "./reviewer.js";
import type { ApprovalRule } from "./rules.js";

/** Where the user's rules come from (the database, in the runtime). */
export interface RuleSource {
  /** The rules that apply to this bot: its own and the global ones. */
  rulesFor(botId: string): Promise<ApprovalRule[]>;
}

export interface GateCall {
  runId: string;
  callId: string;
  botId: string;
  name: string;
  args: JsonValue;
  /** The tools the bot may use. */
  allowed?: string[] | undefined;
  executor: Executor;
}

export interface GateVerdict {
  outcome: PolicyOutcome;
  source: PolicySource;
  level: RiskLevel;
  ruleId?: string;
  reason?: string;
  /** The line of the card. */
  summary: string;
  /** The secret names the call uses. */
  secrets: string[];
  /** The arguments as they will run. */
  args: JsonValue;
  /** Present only when the tool declares the call as a message to another person. */
  outbound?: OutboundMessage;
  /** An `ask` that expires (only when a limit says so). */
  expiresAt?: string;
  /** Only a replay sets it: the id the recording gave the card (the run id differs there). */
  approvalId?: string;
}

/** What the loop asks before running a tool call. `null`: nothing to decide (no such tool, bad arguments). */
export interface ToolGate {
  check(call: GateCall): Promise<GateVerdict | null>;
  /**
   * Set only by `allowAllGate`: this gate decides nothing, so the run is not under any approval
   * policy (the prompt does not promise approvals, and nothing is recorded as gated).
   */
  readonly allowsEverything?: true;
}

/**
 * The gate that lets every call run, unchecked. It exists so that "no approval policy" is a
 * decision somebody writes down, never something a missing field turns into: `LoopDeps.gate` is
 * required. Legitimate uses are a disposable machine without a user to ask (an evaluation), a
 * replay of a run recorded without approvals, and tests. An architecture test lists the files
 * allowed to name it.
 */
export function allowAllGate(): ToolGate {
  return { allowsEverything: true, check: async () => null };
}

export interface ToolGateOptions {
  tools: {
    assess(name: string, rawArgs: unknown, opts: AssessOptions): ToolAssessment | undefined;
  };
  rules: RuleSource;
  /** Default: the level's own table (`levelReviewer`). */
  reviewer?: AutoReviewer;
  /** A level the user fixed for a tool, over what the tool declares. */
  levelOverrides?: Readonly<Record<string, RiskLevel>>;
  /** Approval requests expire after this long. Without it they never do. */
  expireAfterMs?: number;
  now(): Date;
}

export function createToolGate(options: ToolGateOptions): ToolGate {
  const reviewer = options.reviewer ?? levelReviewer;
  return {
    async check(call) {
      const assessed = options.tools.assess(call.name, call.args, {
        executor: call.executor,
        ...(call.allowed === undefined ? {} : { allowed: call.allowed }),
      });
      if (assessed === undefined) return null;
      const level = options.levelOverrides?.[call.name] ?? assessed.level;
      const rules = await options.rules.rulesFor(call.botId);
      const ruleCall = { botId: call.botId, tool: call.name, args: assessed.args };
      let review: ReviewVerdict;
      try {
        review = await reviewer.review({ ...ruleCall, level, summary: assessed.summary });
      } catch {
        review = { verdict: "sensitive", reason: "the automatic review failed" };
      }
      const decision = decidePolicy({ call: ruleCall, level, rules, review });
      return {
        outcome: decision.outcome,
        source: decision.source,
        level,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        summary: assessed.summary,
        secrets: assessed.secrets,
        args: assessed.args,
        ...(assessed.outbound === undefined ? {} : { outbound: assessed.outbound }),
        ...(decision.outcome === "ask" && options.expireAfterMs !== undefined
          ? { expiresAt: new Date(options.now().getTime() + options.expireAfterMs).toISOString() }
          : {}),
      };
    },
  };
}

/**
 * The gate of a replay: the verdicts the recording holds, call by call. A call the recording
 * never gated (a plain read) is not gated now either.
 */
export function createReplayGate(events: readonly { type: string; payload?: unknown }[]): ToolGate {
  const verdicts = new Map<string, GateVerdict>();
  for (const event of events as readonly RunEventData[]) {
    if (event.type === "policy_checked") {
      const p = event.payload;
      verdicts.set(p.callId, {
        outcome: p.outcome,
        source: p.source,
        level: p.level,
        ...(p.ruleId === undefined ? {} : { ruleId: p.ruleId }),
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        summary: "",
        secrets: [],
        args: null,
      });
    } else if (event.type === "approval_requested") {
      const p = event.payload;
      verdicts.set(p.callId, {
        outcome: "ask",
        approvalId: p.approvalId,
        source: p.source,
        level: p.level,
        summary: p.summary,
        secrets: p.secrets,
        args: p.args,
        ...(p.outbound === undefined ? {} : { outbound: p.outbound }),
        ...(p.expiresAt === undefined ? {} : { expiresAt: p.expiresAt }),
      });
    }
  }
  return {
    async check(call) {
      const found = verdicts.get(call.callId);
      return found === undefined
        ? null
        : structuredClone({ ...found, args: found.args ?? call.args });
    },
  };
}
