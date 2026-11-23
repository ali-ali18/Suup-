// Owns turning a tool call into a verdict: it asks the registry for the call's level and card
// text, loads the user's rules, asks the reviewer, and applies `decidePolicy`. The loop calls it
// and records what it says; replays serve the recorded verdicts instead (`createReplayGate`).
import type { ApprovalReview, PolicySource, RunEventData } from "../events.js";
import type { JsonValue } from "../messages.js";
import type { OutboundMessage } from "../outbound.js";
import type { AssessOptions, ToolAssessment } from "../registry.js";
import type { RiskLevel } from "../risk.js";
import type { Executor } from "../tool.js";
import type { WebUrlSource } from "../web.js";
import {
  decidedBeforeReview,
  decidePolicy,
  type PolicyOutcome,
  type ReviewResolution,
  resolveReview,
} from "./decide.js";
import { reviewArgsText } from "./model-reviewer.js";
import {
  type AutoReviewer,
  levelReviewer,
  REVIEW_VERDICTS,
  type ReviewTrigger,
  type ReviewVerdict,
} from "./reviewer.js";
import type { ApprovalRule } from "./rules.js";
import type { ApprovalMode, ApprovalModeSource, WrittenRuleSource } from "./written-rules.js";

/** The model reviewer stops deciding for a run after this many refusals in a row... */
export const REVIEW_MAX_CONSECUTIVE_BLOCKS = 3;
/** ...or this many in all: from then on the user is asked. */
export const REVIEW_MAX_TOTAL_BLOCKS = 20;

/** The tool that asks the user to open the network to one host: it is always a card. */
export const NETWORK_ACCESS_TOOL = "request_network_access";

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
  /**
   * What the model reviewer is shown of the user's side of the run: the user's own messages,
   * oldest first. Never the assistant's text or a tool result. Only the loop fills it.
   */
  userMessages?: readonly string[] | undefined;
  /**
   * What started the run when it was not the user typing now: a routine's fire. The model reviewer
   * is told so (the fire is not live input and never approval) and sees the routine's instruction,
   * stored earlier with the user's approval, apart from the user's messages.
   */
  trigger?: ReviewTrigger | undefined;
  /** The URLs the run has seen and where each came from (the loop derives them from the log). */
  webSeen?: ReadonlyMap<string, WebUrlSource> | undefined;
  /** The routines the user's messages are about: id to name (see `ClassifyEnv.routineNames`). */
  routineNames?: ReadonlyMap<string, string> | undefined;
  /** The refusals the model reviewer already gave in this run (read from the log). */
  reviewBlocks?: { total: number; consecutive: number } | undefined;
  /** A review of THIS call already in the log (a resumed run): it is used, the model is not asked again. */
  recordedReview?: ApprovalReview | undefined;
  signal?: AbortSignal | undefined;
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
  /** The WRITTEN rule behind a decision of the model reviewer (`ruleId` is for the exact rules). */
  writtenRuleId?: string;
  /** What the model reviewer said about this call, to be recorded (not set when the log has it). */
  review?: ApprovalReview;
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
  /**
   * The reviewer that asks a model (auto-review mode). Without it, or when the mode is
   * `ask_all`, the call is decided as before. It is used only for calls that are not plain reads
   * and that no exact rule, floor or mode has settled.
   */
  modelReviewer?: AutoReviewer;
  /** The approval mode, read at every call. Default: `auto_review`. */
  mode?: ApprovalModeSource;
  /** The rules the user wrote, read by the model reviewer. */
  written?: WrittenRuleSource;
  /** A level the user fixed for a tool, over what the tool declares. */
  levelOverrides?: Readonly<Record<string, RiskLevel>>;
  /** Approval requests expire after this long. Without it they never do. */
  expireAfterMs?: number;
  now(): Date;
}

/**
 * The tools that keep the assistant's OWN memory. The model reviewer is not asked about them (at
 * the reversible level): the owner's rule is that nothing the assistant writes in its memory waits
 * for the user (docs/MEMORIA.md), and the memory has its own guards (the write review after the run
 * read outside content, the history with undo). With the real model the reviewer asked a card for
 * almost every fact the user mentioned, because the text says "Marina" and it cannot see the first
 * message where the name was given. A level the user raised (`approvals.levels`) still applies.
 */
export const MEMORY_KEEPING_TOOLS: readonly string[] = ["remember", "forget"];

/** A call that always asks, whatever the rules, the mode or the reviewer say (docs/APROVACOES.md). */
function hardFloor(name: string, level: RiskLevel, assessed: ToolAssessment): string | undefined {
  if (name === NETWORK_ACCESS_TOOL) {
    return "Liberar a rede para um host sempre precisa da sua decisão.";
  }
  if (
    assessed.secrets.length > 0 &&
    (level === "external_irreversible" || assessed.outbound !== undefined)
  ) {
    return "A chamada usa um segredo do cofre e sai para fora: sempre precisa da sua decisão.";
  }
  return undefined;
}

function reviewFrom(
  call: GateCall,
  tool: string,
  level: RiskLevel,
  verdict: ReviewVerdict,
  resolution: ReviewResolution,
): ApprovalReview {
  const answer = verdict.model;
  return {
    callId: call.callId,
    tool,
    level,
    decision: answer?.decision ?? "ask",
    ruleId: resolution.writtenRuleId ?? null,
    reason: resolution.reason,
    outcome: resolution.outcome,
    ...(resolution.adjusted === undefined ? {} : { adjusted: resolution.adjusted }),
    ...(answer?.failure === undefined ? {} : { skipped: "error" as const }),
    ...(answer === undefined
      ? {}
      : {
          model: answer.model,
          promptVersion: answer.promptVersion,
          usage: answer.usage,
          costUsd: answer.costUsd,
          latencyMs: answer.latencyMs,
        }),
  };
}

export function createToolGate(options: ToolGateOptions): ToolGate {
  const reviewer = options.reviewer ?? levelReviewer;
  return {
    async check(call) {
      const assessed = options.tools.assess(call.name, call.args, {
        executor: call.executor,
        ...(call.webSeen === undefined ? {} : { webSeen: call.webSeen }),
        ...(call.routineNames === undefined ? {} : { routineNames: call.routineNames }),
        ...(call.allowed === undefined ? {} : { allowed: call.allowed }),
      });
      if (assessed === undefined) return null;
      const level = options.levelOverrides?.[call.name] ?? assessed.level;
      const rules = await options.rules.rulesFor(call.botId);
      const ruleCall = { botId: call.botId, tool: call.name, args: assessed.args };
      // A mode that cannot be read is the strictest one.
      let mode: ApprovalMode = "ask_all";
      try {
        mode = (await options.mode?.approvalMode()) ?? "auto_review";
      } catch {
        mode = "ask_all";
      }
      const floor = hardFloor(call.name, level, assessed);
      const early = decidedBeforeReview({ call: ruleCall, level, rules, mode, floor });
      const goesToModel =
        options.modelReviewer !== undefined &&
        options.written !== undefined &&
        mode === "auto_review" &&
        level !== "read" &&
        !(level === "write_reversible" && MEMORY_KEEPING_TOOLS.includes(call.name)) &&
        early === undefined;

      let resolved: ReviewResolution | undefined;
      let review: ReviewVerdict | undefined;
      let record: ApprovalReview | undefined;
      if (goesToModel && options.modelReviewer !== undefined && options.written !== undefined) {
        const taken = await modelReview(options.modelReviewer, options.written, call, {
          level,
          summary: assessed.summary,
          toolDescription: assessed.toolDescription,
          args: assessed.args,
          ...(assessed.outbound === undefined ? {} : { outbound: assessed.outbound }),
        });
        resolved = taken.resolution;
        record = taken.record;
      } else {
        try {
          review = await reviewer.review({ ...ruleCall, level, summary: assessed.summary });
          // A missing or unknown verdict is no verdict: the user is asked, the call never just runs.
          if (
            review === undefined ||
            review === null ||
            !REVIEW_VERDICTS.includes(review.verdict)
          ) {
            review = { verdict: "sensitive", reason: "the automatic review gave no valid verdict" };
          }
        } catch {
          review = { verdict: "sensitive", reason: "the automatic review failed" };
        }
      }
      const decision = decidePolicy({
        call: ruleCall,
        level,
        rules,
        review,
        mode,
        floor,
        resolved,
      });
      return {
        outcome: decision.outcome,
        source: decision.source,
        level,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(decision.writtenRuleId === undefined ? {} : { writtenRuleId: decision.writtenRuleId }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        summary: assessed.summary,
        secrets: assessed.secrets,
        args: assessed.args,
        ...(assessed.outbound === undefined ? {} : { outbound: assessed.outbound }),
        ...(record === undefined || call.recordedReview !== undefined ? {} : { review: record }),
        ...(decision.outcome === "ask" && options.expireAfterMs !== undefined
          ? { expiresAt: new Date(options.now().getTime() + options.expireAfterMs).toISOString() }
          : {}),
      };
    },
  };
}

/**
 * Asks the model reviewer about one call, unless the log already holds its answer or a limit says
 * the user is asked instead. Everything that is not a clean answer ends in `ask`.
 */
async function modelReview(
  reviewer: AutoReviewer,
  written: WrittenRuleSource,
  call: GateCall,
  proposed: {
    level: RiskLevel;
    summary: string;
    toolDescription: string;
    args: JsonValue;
    outbound?: OutboundMessage;
  },
): Promise<{ resolution: ReviewResolution; record: ApprovalReview }> {
  const base = { callId: call.callId, tool: call.name, level: proposed.level } as const;
  const skip = (skipped: "cap" | "too_large" | "error", reason: string) => {
    const resolution: ReviewResolution = { outcome: "ask", reason };
    return {
      resolution,
      record: {
        ...base,
        decision: "ask" as const,
        ruleId: null,
        reason,
        outcome: "ask" as const,
        skipped,
      },
    };
  };
  // Decided before, in the log: what happened stays what happened.
  const recorded = call.recordedReview;
  if (recorded !== undefined) {
    return {
      resolution: {
        outcome: recorded.outcome,
        ...(recorded.ruleId === null ? {} : { writtenRuleId: recorded.ruleId }),
        reason: recorded.reason,
      },
      record: recorded,
    };
  }
  const blocks = call.reviewBlocks ?? { total: 0, consecutive: 0 };
  if (
    blocks.consecutive >= REVIEW_MAX_CONSECUTIVE_BLOCKS ||
    blocks.total >= REVIEW_MAX_TOTAL_BLOCKS
  ) {
    return skip(
      "cap",
      "A revisão automática já bloqueou chamadas demais nesta execução: agora é você quem decide.",
    );
  }
  if (reviewArgsText(proposed.args) === null) {
    return skip("too_large", "Os argumentos são grandes demais para a revisão automática.");
  }
  let rules: Awaited<ReturnType<WrittenRuleSource["writtenRulesFor"]>>;
  try {
    rules = await written.writtenRulesFor(call.botId);
  } catch {
    return skip("error", "Não foi possível ler as suas regras escritas.");
  }
  let verdict: ReviewVerdict | undefined;
  try {
    verdict = await reviewer.review({
      botId: call.botId,
      tool: call.name,
      args: proposed.args,
      level: proposed.level,
      summary: proposed.summary,
      context: {
        toolDescription: proposed.toolDescription,
        ...(proposed.outbound === undefined ? {} : { outbound: proposed.outbound }),
        userMessages: call.userMessages ?? [],
        ...(call.trigger === undefined ? {} : { trigger: call.trigger }),
        rules,
        signal: call.signal,
      },
    });
  } catch {
    verdict = undefined;
  }
  const answer = verdict?.model;
  if (verdict === undefined || answer === undefined || !REVIEW_VERDICTS.includes(verdict.verdict)) {
    return skip("error", "A revisão automática não deu uma resposta válida.");
  }
  const resolution = resolveReview(answer, proposed.level, rules);
  return { resolution, record: reviewFrom(call, call.name, proposed.level, verdict, resolution) };
}

/**
 * The gate of a replay: the verdicts the recording holds, call by call. A call the recording
 * never gated (a plain read) is not gated now either.
 */
export function createReplayGate(events: readonly { type: string; payload?: unknown }[]): ToolGate {
  const verdicts = new Map<string, GateVerdict>();
  const reviews = new Map<string, ApprovalReview>();
  for (const event of events as readonly RunEventData[]) {
    if (event.type === "approval_review") {
      reviews.set(event.payload.callId, event.payload);
    } else if (event.type === "policy_checked") {
      const p = event.payload;
      verdicts.set(p.callId, {
        outcome: p.outcome,
        source: p.source,
        level: p.level,
        ...(p.ruleId === undefined ? {} : { ruleId: p.ruleId }),
        ...(p.writtenRuleId === undefined ? {} : { writtenRuleId: p.writtenRuleId }),
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        summary: "",
        secrets: [],
        args: null,
      });
    } else if (event.type === "approval_grant_used") {
      // The gate said "ask" and a late approval's grant stood in for the card: nothing else was logged.
      verdicts.set(event.payload.callId, {
        outcome: "ask",
        source: "default",
        level: "external_irreversible",
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
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        ...(p.writtenRuleId === undefined ? {} : { writtenRuleId: p.writtenRuleId }),
      });
    }
  }
  return {
    async check(call) {
      const found = verdicts.get(call.callId);
      if (found === undefined) return null;
      const review = reviews.get(call.callId);
      return structuredClone({
        ...found,
        args: found.args ?? call.args,
        ...(review === undefined ? {} : { review }),
      });
    },
  };
}
