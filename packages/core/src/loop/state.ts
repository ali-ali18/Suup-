import type {
  EscalateQuestion,
  PlanStep,
  RunEventPayload,
  RunStatus,
  ToolCatalog,
} from "../events.js";
import { escalatedQuestions } from "../events.js";
import type { Block, JsonValue, Message, ToolCallBlock } from "../messages.js";
import type { GenerateResult, StopReason } from "../provider.js";
import type { WebUrlSource } from "../web.js";
import { formatDiscrepancies, isControlTool } from "./control-tools.js";
import { historyMessages } from "./history.js";
import {
  isReminderBlock,
  progressContinueNotice,
  type RunPromptContext,
  renderNotice,
  renderReturnNotice,
  renderRoutineRef,
  renderSummaryMessage,
  renderUserMessage,
} from "./prompts.js";
import type { FailureOrigin, RunResult, StoredEvent } from "./store.js";
import { createWatchState, reopenWindow, trackCall, type WatchState } from "./watch-state.js";

/** The question as the history keeps it: the text, then the choices that were offered (if any). */
function withOptions(question: string, questions: readonly EscalateQuestion[] | undefined): string {
  const offered = (questions ?? [])
    .map((q, i) =>
      q.options === undefined
        ? undefined
        : `${questions !== undefined && questions.length > 1 ? `${i + 1}. ` : ""}${q.multiple === true ? "pick several: " : ""}${q.options.map((o) => o.label).join(" | ")}`,
    )
    .filter((line) => line !== undefined);
  return offered.length === 0 ? question : `${question}\nOptions offered:\n${offered.join("\n")}`;
}

/** A tool call the model asked for whose result is not recorded yet. */
export interface PendingCall {
  id: string;
  name: string;
  args: JsonValue;
  /** A `tool_call` event exists: the call may have started running. */
  started: boolean;
}

/** The latest model response, as long as the harness has not finished acting on it. */
export interface PendingResponse {
  blocks: Block[];
  stopReason: StopReason;
  toolCalls: ToolCallBlock[];
}

/** Why the run is paused waiting for a person. */
export type Waiting =
  | { kind: "escalate"; callId: string; question: string; questions?: EscalateQuestion[] }
  | { kind: "review_tie_break"; question: string }
  /** A call waits for the user's decision on the approval card. */
  | { kind: "approval"; callId: string; approvalId: string }
  /** The bot asked the user for a credential. */
  | { kind: "secret"; callId: string; name: string }
  /** The watchdog asked the owner to continue or stop (step limit, or a loop). */
  | {
      kind: "progress";
      question: string;
      questions: EscalateQuestion[];
      cause: "limit" | "repeat" | "error_loop" | "no_tool" | "alternation";
      grant: number;
    };

/** A return the bot asked for (`wait_scheduled`) that has neither fired nor been cancelled. */
export interface PendingReturn {
  at: string;
  note: string;
  minutes: number;
  callId?: string;
  /** The run was settled into `waiting_timer` for it (the status change is in the log). */
  parked: boolean;
}

/** The approval of one call, as the log tells it. */
export interface ApprovalRecord {
  requested: RunEventPayload<"approval_requested">;
  decided?: RunEventPayload<"approval_decided">;
}

export interface ToolLogEntry {
  callId: string;
  name: string;
  /** Arguments as compact JSON, clipped (see `argsLength`). */
  args: string;
  /** Length of the whole arguments JSON; larger than `args` when they were clipped. */
  argsLength: number;
  outcome: RunEventPayload<"tool_result">["outcome"];
  isError: boolean;
  /** Length of the result text. */
  length: number;
  head: string;
  /** Empty when the whole result fits in `head`. */
  tail: string;
}

/**
 * One step of the conversation between the assistant and the user that the tool log does not
 * show (the control tools are not in it): a question the assistant asked with `escalate`, the
 * user's answer, or a message the user sent while the run was working.
 */
export interface UserExchange {
  kind: "question" | "answer" | "message";
  text: string;
}

export type ReviewStep =
  | { kind: "evidence"; payload: RunEventPayload<"review_evidence"> }
  | { kind: "reprompt"; payload: RunEventPayload<"review_reprompt"> };

export interface FinishAttemptRecord {
  accepted: boolean;
  reasons: string[];
  handedToUser: boolean;
}

/** The response of a review, compaction or progress call that no event has used yet. */
export interface SideResponse {
  purpose: "review" | "compaction" | "progress";
  /** `seq` of the `model_response` event. It is only reusable while it is the latest event. */
  seq: number;
  result: GenerateResult;
}

/** Everything the loop knows about a run, derived only from its events. */
export interface RunState {
  /**
   * The conversation as the model will see it, without the STATE REMINDER. While tool results are
   * still being collected, the last message is the user message they go into. May end with an
   * assistant message that has unanswered calls (see `pendingCalls`).
   */
  messages: Message[];
  /** `seq` of the last event that contributed to each message; parallel to `messages`. */
  messageSeqs: number[];
  /** The last message is a user message that later events still append to. */
  userOpen: boolean;
  plan: PlanStep[];
  /** A plan with at least one step was ever saved. A plan that exists is never "absent" again. */
  hasPlan: boolean;
  /** Last status the event log announced (null until the first `status_changed`). */
  status: RunStatus | null;
  statusDetail: { failure?: { origin: FailureOrigin; detail: string }; result?: RunResult };
  started: boolean;
  /** `seq` of `run_started` (0 until it is seen). */
  startSeq: number;
  /** The `context_loaded` event is in the log. */
  contextLoaded: boolean;
  /** How the run offers its connector tools (the `tool_catalog` event), or null (none decided). */
  toolCatalog: ToolCatalog | null;
  /** An agent `model_request` was recorded: the tools of the run can no longer be decided. */
  sawRequest: boolean;
  /** The rules and profile of the run, for the system prompt; null without a `context_loaded`. */
  context: RunPromptContext | null;
  lastSeq: number;
  /** Agent model responses seen. */
  responses: number;
  pending: PendingResponse | null;
  pendingCalls: PendingCall[];
  /** Outcomes of the calls of the turn in progress, for the no-progress count. */
  turnOutcomes: { name: string; failed: boolean }[];
  waiting: Waiting | null;
  /** The return the bot scheduled and that has not fired or been cancelled yet; one at most. */
  wait: PendingReturn | null;
  /** Returns that fired since the user last wrote to the run (the cap counts these). */
  wakeCount: number;
  /** Milliseconds the run spent parked for returns; the duration limit does not count them. */
  waitedMs: number;
  /** When the run was parked, while it is. */
  parkedAt: Date | null;
  /** A `finish` was accepted but the run has not been closed yet. */
  acceptedFinish: { summary: string; evidence: { criterion: string; evidence: string }[] } | null;
  /** Unverified finishes already sent back to the bot to produce the evidence (at most one). */
  unverifiedSentBack: number;
  /** The harness already sent a plain-text end back asking for `finish` (criteria, no plan). */
  finishRequested: boolean;
  /** A `finish` ended the run as not concluded (`finish_attempt.endsRun`), not closed yet. */
  failedFinish: { origin: FailureOrigin; detail: string } | null;
  finishAttempts: Map<string, FinishAttemptRecord>;
  /** The review recorded since the latest `finish` call started, if any. */
  currentReview: RunEventPayload<"review"> | null;
  /** The evidence rounds of the review in progress (since the latest `finish` call started). */
  reviewRounds: RunEventPayload<"review_evidence">[];
  /**
   * What happened in the review in progress, in order: each evidence round and each time the
   * reviewer was asked again after an invalid `reject`. It rebuilds the conversation with the
   * reviewer exactly, whether live, resumed or replayed.
   */
  reviewSteps: ReviewStep[];
  /** Reviews that rejected for real (not warnings). */
  reviewRejections: number;
  lastRejectionNotes: string;
  /** A human settled a review tie: later finishes are not reviewed again. */
  reviewWaived: boolean;
  /** Consecutive turns with no tool call other than a rejected finish/escalate. */
  noProgressStreak: number;
  repeat: { signature: string | null; name: string; count: number; nudged: boolean };
  /** The progress watchdog's memory of the recent calls and of the steps granted (watch-state.ts). */
  watch: WatchState;
  toolLog: ToolLogEntry[];
  /** Questions to the user, their answers and their messages, in order. Shown to the reviewer. */
  userLog: UserExchange[];
  /** Tokens (input + output) the provider reported for the latest response; null if unknown. */
  usageAnchor: number | null;
  /** Characters appended to the conversation since that response. */
  charsSince: number;
  /**
   * A review or summarizing call was answered but its outcome was not logged yet (the process
   * died in between). A resumed loop uses it instead of paying for the call again.
   */
  sideResponse: SideResponse | null;
  /** Ids of the inbox items the log already delivers (see `RunStore`). */
  deliveredInbox: Set<string>;
  /** Approvals by call id: the request and, once it is in the log, the decision. */
  approvals: Map<string, ApprovalRecord>;
  /** Approvals given too late (`approval_stale`), by the call id of the card. */
  staleApprovals: Map<string, RunEventPayload<"approval_stale">>;
  /**
   * The one-time grants a late approval left (see `grants.ts`), oldest first. `used` is set by an
   * `approval_grant_used`; the grant never outlives the run.
   */
  grants: { approvalId: string; tool: string; args: JsonValue; used: boolean }[];
  /** Calls that ran on a grant, by the new call id: the approval whose grant they consumed. */
  grantUses: Map<string, string>;
  /**
   * The card the user denied and that no model request has come after yet. A user message
   * delivered while it is set is about that denial (by the order of the log, never the text).
   */
  denialLink: { approvalId: string; tool: string } | null;
  /** The verdicts the policy gave (allow or deny), by call id. A resumed loop reuses them. */
  policies: Map<string, RunEventPayload<"policy_checked">>;
  /** A call of the turn in progress was denied: the calls after it are not run. */
  denied: { callId: string; name: string } | null;
  /** The model reviewer's reviews by call id (`approval_review`). A resumed loop reuses them. */
  reviews: Map<string, RunEventPayload<"approval_review">>;
  /** Reviews that refused a call (outcome `deny`): in all, and in a row at the end. */
  reviewBlocks: { total: number; consecutive: number };
  /**
   * What the USER said in this run, oldest first, as the model reviewer is shown it: the earlier
   * messages of the conversation, the objective, the messages sent during the run and the answers
   * to the assistant's questions. Never what the assistant said or a tool returned.
   */
  userSaid: string[];
  /**
   * The instruction of the routine that opened this run (its objective), or `null` for a run the
   * user opened. A routine's fire is NOT live input from the user and never approval (the research,
   * Claude Code routines: the fired prompt "can't act as approval or consent"): its text is kept
   * out of `userSaid` and the reviewer is told the run was started by a routine.
   */
  routineInstruction: string | null;
  /**
   * The names of the tools whose calls ran and got a result in this run (denied or malformed calls
   * did not run). The memory checks use it: a run that used a tool that may bring in content from
   * outside cannot write rules or facts about the user without a review.
   */
  toolsUsed: string[];
  /**
   * The URLs that tool results put in front of the model, and which tool did: `web_search` hits
   * (`search_result`) and the links of pages read with `web_read` (`page_link`). Read from the
   * `webUrls` of `tool_result` events. The user's own URLs are in `userSaid` (see `webUrlsSeen`).
   */
  webSeen: Map<string, WebUrlSource>;
  /**
   * The routines the user's messages are about (the app's "Editar"), id to name: from
   * `context_loaded.routineRefs` and `user_message.routineRef`. A card names them by name.
   */
  routineNames: Map<string, string>;
  /** The share of the context window past which the run compacts (recorded in `context_loaded`). */
  compactionThreshold: number | null;
}

export function createRunState(): RunState {
  return {
    messages: [],
    messageSeqs: [],
    userOpen: false,
    plan: [],
    hasPlan: false,
    status: null,
    statusDetail: {},
    started: false,
    startSeq: 0,
    contextLoaded: false,
    context: null,
    toolsUsed: [],
    webSeen: new Map(),
    routineNames: new Map(),
    compactionThreshold: null,
    lastSeq: 0,
    responses: 0,
    pending: null,
    pendingCalls: [],
    toolCatalog: null,
    sawRequest: false,
    turnOutcomes: [],
    waiting: null,
    wait: null,
    wakeCount: 0,
    waitedMs: 0,
    parkedAt: null,
    acceptedFinish: null,
    failedFinish: null,
    finishRequested: false,
    unverifiedSentBack: 0,
    finishAttempts: new Map(),
    currentReview: null,
    reviewRounds: [],
    reviewSteps: [],
    reviewRejections: 0,
    lastRejectionNotes: "",
    reviewWaived: false,
    noProgressStreak: 0,
    repeat: { signature: null, name: "", count: 0, nudged: false },
    watch: createWatchState(),
    toolLog: [],
    userLog: [],
    usageAnchor: null,
    charsSince: 0,
    sideResponse: null,
    deliveredInbox: new Set(),
    approvals: new Map(),
    policies: new Map(),
    staleApprovals: new Map(),
    grants: [],
    grantUses: new Map(),
    denialLink: null,
    denied: null,
    reviews: new Map(),
    reviewBlocks: { total: 0, consecutive: 0 },
    userSaid: [],
    routineInstruction: null,
  };
}

const MAX_TOOL_LOG = 400;
const DIGEST_SNIPPET = 1000;
export const ARGS_SNIPPET = 200;

/**
 * Rebuilds a run's state from its events. This is the ONLY way the loop gets its conversation:
 * on a fresh run and on resume alike.
 *
 * - `model_response` -> an assistant message.
 * - `tool_result`, `user_message` and `nudge` -> blocks of the user message that follows.
 * - `plan_updated` -> the plan.
 * - `compacted` -> replaces every message up to its `uptoSeq` with the summary.
 */
export function rebuildState(events: readonly StoredEvent[]): RunState {
  const state = createRunState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** Folds one event into the state (in place). `rebuildState` is a fold of this. */
export function applyEvent(state: RunState, event: StoredEvent): void {
  state.lastSeq = event.seq;
  switch (event.type) {
    case "run_started":
      state.started = true;
      state.startSeq = event.seq;
      appendUserBlock(state, { type: "text", text: event.payload.objective }, event.seq);
      if (event.payload.origin === "routine") state.routineInstruction = event.payload.objective;
      else state.userSaid.push(event.payload.objective);
      break;

    case "context_loaded": {
      // Always right after `run_started`: the earlier turns of the conversation go BEFORE the
      // objective, and the conversation only ever grows at the end after that.
      state.contextLoaded = true;
      state.context = {
        rules: structuredClone(event.payload.rules),
        profile: structuredClone(event.payload.profile),
        secrets: structuredClone(event.payload.secrets ?? []),
        ...(event.payload.now === undefined ? {} : { now: structuredClone(event.payload.now) }),
        ...(event.payload.ownerName === undefined ? {} : { ownerName: event.payload.ownerName }),
        ...(event.payload.team === undefined ? {} : { team: structuredClone(event.payload.team) }),
        ...(event.payload.machine === undefined
          ? {}
          : { machine: structuredClone(event.payload.machine) }),
        ...(event.payload.connectors === undefined
          ? {}
          : { connectors: structuredClone(event.payload.connectors) }),
        ...(event.payload.reception === undefined ? {} : { reception: event.payload.reception }),
        ...(event.payload.supervisor === undefined ? {} : { supervisor: event.payload.supervisor }),
        ...(event.payload.routine === undefined
          ? {}
          : { routine: structuredClone(event.payload.routine) }),
        ...(event.payload.ownRoutines === undefined
          ? {}
          : { ownRoutines: structuredClone(event.payload.ownRoutines) }),
        ...(event.payload.task === undefined ? {} : { task: structuredClone(event.payload.task) }),
        ...(event.payload.taskResult === undefined
          ? {}
          : { taskResult: structuredClone(event.payload.taskResult) }),
        ...(event.payload.recentUserMessages === undefined
          ? {}
          : { recentUserMessages: structuredClone(event.payload.recentUserMessages) }),
      };
      state.compactionThreshold = event.payload.compactionThreshold ?? null;
      // The user's earlier messages come before the objective (the history is text only).
      state.userSaid.unshift(
        ...event.payload.history.flatMap((m) =>
          m.role === "user"
            ? m.blocks.flatMap((b) => (b.type === "text" && b.text.trim() !== "" ? [b.text] : []))
            : [],
        ),
      );
      // The routines the opening messages are about: a note in the objective's turn (the last
      // message so far), never in the text of the user.
      for (const ref of event.payload.routineRefs ?? []) {
        state.routineNames.set(ref.id, ref.name);
        const objective = state.messages[state.messages.length - 1];
        const block = { type: "text" as const, text: renderRoutineRef(ref) };
        if (objective?.role === "user") objective.blocks.push(block);
        state.charsSince += blockChars(block);
      }
      const history = historyMessages(event.payload.history, event.payload.historyNote);
      if (history.length === 0) break;
      const seqs = history.map(() => state.startSeq);
      const first = state.messages[0];
      const last = history[history.length - 1];
      if (first?.role === "user" && last?.role === "user") {
        // The history ends with a user message that got no answer: it shares a turn with the objective.
        last.blocks.push(...first.blocks);
        seqs[seqs.length - 1] = state.messageSeqs[0] ?? state.startSeq;
        state.messages = [...history, ...state.messages.slice(1)];
        state.messageSeqs = [...seqs, ...state.messageSeqs.slice(1)];
      } else {
        state.messages = [...history, ...state.messages];
        state.messageSeqs = [...seqs, ...state.messageSeqs];
      }
      break;
    }

    case "model_response": {
      const purpose = event.payload.purpose;
      if (purpose === "review" || purpose === "compaction" || purpose === "progress") {
        const { blocks, stopReason, usage, modelVersion } = event.payload;
        state.sideResponse = {
          purpose,
          seq: event.seq,
          result: structuredClone({ blocks, stopReason, usage, modelVersion }),
        };
        break;
      }
      const { blocks, stopReason, usage } = event.payload;
      state.messages.push({
        role: "assistant",
        blocks:
          blocks.length > 0 ? structuredClone(blocks) : [{ type: "text", text: "(no output)" }],
      });
      state.messageSeqs.push(event.seq);
      state.userOpen = false;
      state.responses += 1;
      const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === "tool_call");
      state.pending = {
        blocks: structuredClone(blocks),
        stopReason,
        toolCalls: structuredClone(toolCalls),
      };
      state.pendingCalls = toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        args: c.args,
        started: false,
      }));
      state.turnOutcomes = [];
      state.denied = null;
      state.usageAnchor = usage.inputTokens + usage.outputTokens;
      state.charsSince = 0;
      break;
    }

    case "tool_catalog":
      state.toolCatalog = structuredClone(event.payload);
      break;

    case "tool_call": {
      const call = state.pendingCalls.find((c) => c.id === event.payload.callId);
      if (call !== undefined) {
        call.started = true;
        // A call made through `use_tool` is logged as the REAL tool it runs: from here on the
        // run knows it (digests, repeats, denials) by that name and those arguments.
        call.name = event.payload.name;
        call.args = event.payload.args as JsonValue;
      }
      if (event.payload.name === "finish") {
        state.currentReview = null;
        state.reviewRounds = [];
        state.reviewSteps = [];
      }
      break;
    }

    case "tool_result": {
      const index = state.pendingCalls.findIndex((c) => c.id === event.payload.callId);
      const call = state.pendingCalls[index];
      if (call === undefined) break;
      state.pendingCalls.splice(index, 1);
      const { content, isError, outcome } = event.payload;
      for (const id of event.payload.inboxIds ?? []) state.deliveredInbox.add(id);
      appendUserBlock(
        state,
        {
          type: "tool_result",
          callId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
          ...(event.payload.toolReferences === undefined
            ? {}
            : { toolReferences: [...event.payload.toolReferences] }),
        },
        event.seq,
      );
      if (
        (state.waiting?.kind === "escalate" || state.waiting?.kind === "secret") &&
        state.waiting.callId === call.id
      ) {
        state.waiting = null;
      }
      if (
        outcome !== "denied" &&
        outcome !== "invalid_args" &&
        outcome !== "unknown_tool" &&
        !state.toolsUsed.includes(call.name)
      ) {
        state.toolsUsed.push(call.name);
      }
      for (const url of event.payload.webUrls ?? []) {
        const source = call.name === "web_search" ? "search_result" : "page_link";
        if (call.name === "web_search" || call.name === "web_read") {
          if (!state.webSeen.has(url)) state.webSeen.set(url, source);
        }
      }
      if (outcome === "denied" && state.denied === null) {
        state.denied = { callId: call.id, name: call.name };
      }
      state.turnOutcomes.push({
        name: call.name,
        failed:
          isError &&
          (call.name === "finish" || call.name === "escalate" || call.name === "request_secret"),
      });
      trackRepeat(state, call, content, isError);
      if (!isControlTool(call.name)) {
        trackCall(
          state.watch,
          { name: call.name, args: canonicalJson(call.args), isError, outcome, content },
          event.payload.risk ?? state.policies.get(call.id)?.level,
        );
      }
      if ((call.name === "escalate" || call.name === "request_secret") && !isError) {
        logUser(state, "answer", content);
        if (call.name === "escalate") state.userSaid.push(content);
      }
      if (!isControlTool(call.name)) logTool(state, call, event.payload, outcome);
      if (state.pendingCalls.length === 0) completeToolTurn(state);
      break;
    }

    case "policy_checked":
      state.policies.set(event.payload.callId, event.payload);
      break;

    case "approval_review": {
      state.reviews.set(event.payload.callId, event.payload);
      if (event.payload.outcome === "deny") {
        state.reviewBlocks.total += 1;
        state.reviewBlocks.consecutive += 1;
      } else {
        state.reviewBlocks.consecutive = 0;
      }
      break;
    }

    case "approval_requested":
      state.approvals.set(event.payload.callId, { requested: event.payload });
      state.waiting = {
        kind: "approval",
        callId: event.payload.callId,
        approvalId: event.payload.approvalId,
      };
      break;

    case "approval_decided": {
      const record = state.approvals.get(event.payload.callId);
      if (record !== undefined) record.decided = event.payload;
      if (record !== undefined && event.payload.decision === "denied") {
        state.denialLink = { approvalId: event.payload.approvalId, tool: record.requested.tool };
      }
      if (state.waiting?.kind === "approval" && state.waiting.callId === event.payload.callId) {
        state.waiting = null;
      }
      break;
    }

    case "approval_stale": {
      state.staleApprovals.set(event.payload.callId, event.payload);
      const record = state.approvals.get(event.payload.callId);
      if (record !== undefined) {
        state.grants.push({
          approvalId: event.payload.approvalId,
          tool: record.requested.tool,
          args: structuredClone(record.requested.args as JsonValue),
          used: false,
        });
      }
      break;
    }

    case "approval_grant_used": {
      state.grantUses.set(event.payload.callId, event.payload.approvalId);
      const grant = state.grants.find((g) => g.approvalId === event.payload.approvalId);
      if (grant !== undefined) grant.used = true;
      break;
    }

    case "secret_requested":
      state.waiting = {
        kind: "secret",
        callId: event.payload.callId,
        name: event.payload.name,
      };
      logUser(
        state,
        "question",
        `Asked the user for the secret ${event.payload.name}${event.payload.reason === undefined ? "" : ` (${event.payload.reason})`}.`,
      );
      break;

    case "plan_updated":
      state.plan = structuredClone(event.payload.plan);
      if (state.plan.length > 0) state.hasPlan = true;
      break;

    case "user_message":
      if (event.payload.inboxId !== undefined) state.deliveredInbox.add(event.payload.inboxId);
      logUser(state, "message", event.payload.text);
      state.userSaid.push(event.payload.text);
      appendUserBlock(
        state,
        {
          type: "text",
          text: renderUserMessage(
            event.payload.text,
            event.payload.linkedApprovalId === undefined
              ? undefined
              : linkedTool(state, event.payload.linkedApprovalId),
          ),
        },
        event.seq,
      );
      if (event.payload.routineRef !== undefined) {
        state.routineNames.set(event.payload.routineRef.id, event.payload.routineRef.name);
        appendUserBlock(
          state,
          { type: "text", text: renderRoutineRef(event.payload.routineRef) },
          event.seq,
        );
      }
      // New information from the user: the model deserves a fresh start on its counters.
      state.noProgressStreak = 0;
      state.repeat = { signature: null, name: "", count: 0, nudged: false };
      reopenWindow(state.watch);
      if (state.waiting?.kind === "review_tie_break") {
        state.waiting = null;
        state.reviewWaived = true;
      }
      break;

    case "nudge":
      appendUserBlock(state, { type: "text", text: renderNotice(event.payload.text) }, event.seq);
      if (event.payload.reason === "repetition") state.repeat.nudged = true;
      state.watch.nudged.add(event.payload.reason);
      if (event.payload.reason === "finish_required") state.finishRequested = true;
      if (state.pending !== null && state.pending.toolCalls.length === 0) {
        // The turn had no tool call: the nudge is how the harness answered it.
        state.noProgressStreak += 1;
        state.pending = null;
      }
      break;

    case "finish_attempt": {
      const {
        callId,
        accepted,
        rejectionReasons,
        summary,
        evidence,
        handedToUser,
        endsRun,
        sentBack,
      } = event.payload;
      if (callId !== undefined) {
        state.finishAttempts.set(callId, {
          accepted,
          reasons: [...rejectionReasons],
          handedToUser: handedToUser === true,
        });
      }
      if (accepted) state.acceptedFinish = { summary, evidence: structuredClone(evidence) };
      if (endsRun !== undefined) state.failedFinish = { ...endsRun };
      if (sentBack === true) state.unverifiedSentBack += 1;
      break;
    }

    case "review_evidence":
      // The reviewer's answer was used: the next request is a new one.
      state.sideResponse = null;
      state.reviewRounds.push(structuredClone(event.payload));
      state.reviewSteps.push({ kind: "evidence", payload: structuredClone(event.payload) });
      break;

    case "review_reprompt":
      state.sideResponse = null;
      state.reviewSteps.push({ kind: "reprompt", payload: structuredClone(event.payload) });
      break;

    case "review":
      state.sideResponse = null;
      state.currentReview = event.payload;
      if (event.payload.verdict === "reject" && event.payload.warning === undefined) {
        state.reviewRejections += 1;
        state.lastRejectionNotes =
          event.payload.discrepancies === undefined
            ? event.payload.notes
            : `${event.payload.notes}\n${formatDiscrepancies(event.payload.discrepancies)}`;
      }
      break;

    case "escalated":
      logUser(state, "question", withOptions(event.payload.question, event.payload.questions));
      state.waiting =
        event.payload.reason === "progress_limit" && event.payload.progress !== undefined
          ? {
              kind: "progress",
              question: event.payload.question,
              questions: escalatedQuestions(event.payload),
              cause: event.payload.progress.cause,
              grant: event.payload.progress.grant,
            }
          : event.payload.callId !== undefined
            ? {
                kind: "escalate",
                callId: event.payload.callId,
                question: event.payload.question,
                ...(event.payload.questions === undefined
                  ? {}
                  : { questions: event.payload.questions }),
              }
            : { kind: "review_tie_break", question: event.payload.question };
      break;

    case "progress_check": {
      state.sideResponse = null;
      const check = event.payload;
      if (check.trigger === "soft_limit") state.watch.softAt = check.limit;
      if (check.action === "extend" && check.extension !== undefined) {
        state.watch.grants.push(check.extension);
        state.watch.autoExtensions += 1;
      }
      break;
    }

    case "progress_decided": {
      const { choice, grant, typed, text, inboxIds } = event.payload;
      for (const id of inboxIds ?? []) state.deliveredInbox.add(id);
      const asked = state.waiting?.kind === "progress" ? state.waiting : null;
      if (asked !== null) state.waiting = null;
      // The decision is the owner's: the model reads it as a note of the harness, and the owner's
      // own words too when they typed something instead of choosing.
      logUser(state, "answer", text);
      if (typed === true) {
        state.userSaid.push(text);
        appendUserBlock(state, { type: "text", text: renderUserMessage(text) }, event.seq);
      }
      if (choice === "continue") {
        state.watch.grants.push(grant);
        state.watch.ownerExtensions += 1;
        appendUserBlock(
          state,
          {
            type: "text",
            text: renderNotice(progressContinueNotice(asked?.cause ?? "limit", grant)),
          },
          event.seq,
        );
      } else {
        state.watch.stopRequested = true;
      }
      // A text-only turn that was waiting for the decision is answered by it.
      if (state.pending !== null && state.pending.toolCalls.length === 0) state.pending = null;
      state.noProgressStreak = 0;
      state.repeat = { signature: null, name: "", count: 0, nudged: false };
      reopenWindow(state.watch);
      break;
    }

    case "wait_scheduled":
      state.wait = {
        at: event.payload.at,
        note: event.payload.note,
        minutes: event.payload.minutes,
        ...(event.payload.callId === undefined ? {} : { callId: event.payload.callId }),
        parked: false,
      };
      break;

    case "wait_fired":
      endWait(state, event.createdAt);
      state.wakeCount += 1;
      // The model reads it as a message of the harness, never as the user's.
      appendUserBlock(
        state,
        {
          type: "text",
          text: renderNotice(
            renderReturnNotice({
              note: event.payload.note,
              plan: state.plan,
              ...(event.payload.delayMs === undefined ? {} : { delayMs: event.payload.delayMs }),
            }),
          ),
        },
        event.seq,
      );
      state.noProgressStreak = 0;
      break;

    case "wait_cancelled":
      endWait(state, event.createdAt);
      // The user wrote: a person is in the loop again, so the count of returns starts over.
      if (event.payload.reason === "user_message") state.wakeCount = 0;
      break;

    case "status_changed":
      for (const id of event.payload.inboxIds ?? []) state.deliveredInbox.add(id);
      if (event.payload.to === "waiting_timer") {
        state.parkedAt = event.createdAt;
        if (state.wait !== null) state.wait.parked = true;
      }
      state.status = event.payload.to;
      state.statusDetail = {
        ...(event.payload.failure === undefined ? {} : { failure: event.payload.failure }),
        ...(event.payload.result === undefined ? {} : { result: event.payload.result }),
      };
      if (event.payload.to === "done" || event.payload.to === "failed") {
        state.acceptedFinish = null;
        state.failedFinish = null;
      }
      if (state.pending !== null && state.pending.toolCalls.length === 0) state.pending = null;
      break;

    case "compacted": {
      state.sideResponse = null;
      const { uptoSeq, summary } = event.payload;
      const firstKept = state.messageSeqs.findIndex((seq) => seq > uptoSeq);
      const keepFrom = firstKept === -1 ? state.messages.length : firstKept;
      // Thinking blocks are bound to the text before them, which the summary replaces: drop them
      // from the kept messages instead of sending signatures the API would reject.
      const kept = state.messages
        .slice(keepFrom)
        .map((m) => ({ ...m, blocks: m.blocks.filter((b) => !isThinkingData(b)) }));
      state.messages = [
        { role: "user", blocks: [{ type: "text", text: renderSummaryMessage(summary) }] },
        ...kept,
      ];
      state.messageSeqs = [uptoSeq, ...state.messageSeqs.slice(keepFrom)];
      if (keepFrom >= state.messages.length) state.userOpen = false;
      state.usageAnchor = null;
      state.charsSince = 0;
      break;
    }

    case "model_request": {
      if (event.payload.purpose === undefined) {
        state.sawRequest = true;
        // The model goes on: what the user writes from here on is no longer about the denial.
        state.denialLink = null;
      }
      // The STATE REMINDER sent with an agent request becomes a permanent part of that user
      // message, so later requests extend this one instead of rewriting it.
      if (event.payload.purpose !== undefined) break;
      const sent = event.payload.messages[event.payload.messages.length - 1];
      const reminder = sent?.blocks[sent.blocks.length - 1];
      const tail = state.messages[state.messages.length - 1];
      if (reminder === undefined || !isReminderBlock(reminder) || tail?.role !== "user") break;
      tail.blocks = tail.blocks.filter((b) => !isReminderBlock(b));
      tail.blocks.push(structuredClone(reminder));
      break;
    }

    case "model_error":
      break;
  }
}

/** The tool of the card a message was linked to ("" if the card is not in the log). */
function linkedTool(state: RunState, approvalId: string): string {
  for (const record of state.approvals.values()) {
    if (record.requested.approvalId === approvalId) return record.requested.tool;
  }
  return "";
}

/** The pending return ended (fired or cancelled): the time parked stops counting. */
function endWait(state: RunState, at: Date): void {
  state.wait = null;
  if (state.parkedAt !== null) {
    state.waitedMs += Math.max(0, at.getTime() - state.parkedAt.getTime());
    state.parkedAt = null;
  }
}

/** Opaque provider data holding a thinking block (visible or redacted). */
function isThinkingData(block: Block): boolean {
  if (block.type !== "provider_data") return false;
  const data = block.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  return data.type === "thinking" || data.type === "redacted_thinking";
}

function completeToolTurn(state: RunState): void {
  const progress = state.turnOutcomes.some((o) => !o.failed);
  state.noProgressStreak = progress ? 0 : state.noProgressStreak + 1;
  state.turnOutcomes = [];
  state.pending = null;
}

function appendUserBlock(state: RunState, block: Block, seq: number): void {
  const last = state.messages[state.messages.length - 1];
  if (state.userOpen && last !== undefined && last.role === "user") {
    last.blocks.push(block);
    state.messageSeqs[state.messageSeqs.length - 1] = seq;
  } else {
    state.messages.push({ role: "user", blocks: [block] });
    state.messageSeqs.push(seq);
    state.userOpen = true;
  }
  state.charsSince += blockChars(block);
}

function trackRepeat(state: RunState, call: PendingCall, content: string, isError: boolean): void {
  const signature = `${call.name}\u0000${canonicalJson(call.args)}\u0000${isError}\u0000${content}`;
  if (state.repeat.signature === signature) {
    state.repeat.count += 1;
  } else {
    state.repeat = { signature, name: call.name, count: 1, nudged: false };
  }
}

const MAX_USER_LOG = 40;
const USER_LOG_CLIP = 1500;

function logUser(state: RunState, kind: UserExchange["kind"], text: string): void {
  state.userLog.push({ kind, text: clip(text.trim(), USER_LOG_CLIP) });
  if (state.userLog.length > MAX_USER_LOG) state.userLog.shift();
}

function logTool(
  state: RunState,
  call: PendingCall,
  result: RunEventPayload<"tool_result">,
  outcome: ToolLogEntry["outcome"],
): void {
  const { content } = result;
  const whole = content.length <= DIGEST_SNIPPET * 2;
  state.toolLog.push({
    callId: call.id,
    name: call.name,
    args: clip(canonicalJson(call.args), ARGS_SNIPPET),
    argsLength: canonicalJson(call.args).length,
    outcome,
    isError: result.isError,
    length: content.length,
    head: whole ? content : content.slice(0, DIGEST_SNIPPET),
    tail: whole ? "" : content.slice(-DIGEST_SNIPPET),
  });
  if (state.toolLog.length > MAX_TOOL_LOG) state.toolLog.shift();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** JSON with sorted object keys, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function blockChars(block: Block): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "tool_call":
      return block.name.length + (JSON.stringify(block.args)?.length ?? 0);
    case "tool_result":
      return block.content.length;
    case "provider_data":
      return JSON.stringify(block.data)?.length ?? 0;
  }
}

export function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) for (const b of m.blocks) total += blockChars(b);
  return total;
}

/**
 * Estimated size of the next request in tokens. With a real count from the last response it is
 * that count plus a chars/4 estimate of what was appended since; otherwise chars/4 of everything.
 * `fixedChars` is the size of the system prompt and the tool specs.
 */
export function estimateTokens(state: RunState, fixedChars: number): number {
  if (state.usageAnchor !== null) return state.usageAnchor + Math.ceil(state.charsSince / 4);
  return Math.ceil((fixedChars + messageChars(state.messages)) / 4);
}
