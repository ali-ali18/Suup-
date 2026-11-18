import type { ContextItem, PlanStep, RunEventPayload, RunStatus } from "../events.js";
import type { Block, JsonValue, Message, ToolCallBlock } from "../messages.js";
import type { GenerateResult, StopReason } from "../provider.js";
import { isControlTool } from "./control-tools.js";
import { historyMessages } from "./history.js";
import {
  isReminderBlock,
  renderNotice,
  renderSummaryMessage,
  renderUserMessage,
} from "./prompts.js";
import type { FailureOrigin, RunResult, StoredEvent } from "./store.js";

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
  | { kind: "escalate"; callId: string; question: string }
  | { kind: "review_tie_break"; question: string };

export interface ToolLogEntry {
  callId: string;
  name: string;
  /** Arguments as compact JSON, clipped. */
  args: string;
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

export interface FinishAttemptRecord {
  accepted: boolean;
  reasons: string[];
  handedToUser: boolean;
}

/** The response of a review or compaction call that no event has used yet. */
export interface SideResponse {
  purpose: "review" | "compaction";
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
  /** The rules and profile of the run, for the system prompt; null without a `context_loaded`. */
  context: { rules: ContextItem[]; profile: ContextItem[] } | null;
  lastSeq: number;
  /** Agent model responses seen. */
  responses: number;
  pending: PendingResponse | null;
  pendingCalls: PendingCall[];
  /** Outcomes of the calls of the turn in progress, for the no-progress count. */
  turnOutcomes: { name: string; failed: boolean }[];
  waiting: Waiting | null;
  /** A `finish` was accepted but the run has not been closed yet. */
  acceptedFinish: { summary: string; evidence: { criterion: string; evidence: string }[] } | null;
  finishAttempts: Map<string, FinishAttemptRecord>;
  /** The review recorded since the latest `finish` call started, if any. */
  currentReview: RunEventPayload<"review"> | null;
  /** Reviews that rejected for real (not warnings). */
  reviewRejections: number;
  lastRejectionNotes: string;
  /** A human settled a review tie: later finishes are not reviewed again. */
  reviewWaived: boolean;
  /** Consecutive turns with no tool call other than a rejected finish/escalate. */
  noProgressStreak: number;
  repeat: { signature: string | null; name: string; count: number; nudged: boolean };
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
    lastSeq: 0,
    responses: 0,
    pending: null,
    pendingCalls: [],
    turnOutcomes: [],
    waiting: null,
    acceptedFinish: null,
    finishAttempts: new Map(),
    currentReview: null,
    reviewRejections: 0,
    lastRejectionNotes: "",
    reviewWaived: false,
    noProgressStreak: 0,
    repeat: { signature: null, name: "", count: 0, nudged: false },
    toolLog: [],
    userLog: [],
    usageAnchor: null,
    charsSince: 0,
    sideResponse: null,
    deliveredInbox: new Set(),
  };
}

const MAX_TOOL_LOG = 400;
const DIGEST_SNIPPET = 1000;

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
      break;

    case "context_loaded": {
      // Always right after `run_started`: the earlier turns of the conversation go BEFORE the
      // objective, and the conversation only ever grows at the end after that.
      state.contextLoaded = true;
      state.context = {
        rules: structuredClone(event.payload.rules),
        profile: structuredClone(event.payload.profile),
      };
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
      if (purpose === "review" || purpose === "compaction") {
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
      state.usageAnchor = usage.inputTokens + usage.outputTokens;
      state.charsSince = 0;
      break;
    }

    case "tool_call": {
      const call = state.pendingCalls.find((c) => c.id === event.payload.callId);
      if (call !== undefined) call.started = true;
      if (event.payload.name === "finish") state.currentReview = null;
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
        },
        event.seq,
      );
      if (state.waiting?.kind === "escalate" && state.waiting.callId === call.id) {
        state.waiting = null;
      }
      state.turnOutcomes.push({
        name: call.name,
        failed: isError && (call.name === "finish" || call.name === "escalate"),
      });
      trackRepeat(state, call, content, isError);
      if (call.name === "escalate" && !isError) logUser(state, "answer", content);
      if (!isControlTool(call.name)) logTool(state, call, event.payload, outcome);
      if (state.pendingCalls.length === 0) completeToolTurn(state);
      break;
    }

    case "plan_updated":
      state.plan = structuredClone(event.payload.plan);
      if (state.plan.length > 0) state.hasPlan = true;
      break;

    case "user_message":
      if (event.payload.inboxId !== undefined) state.deliveredInbox.add(event.payload.inboxId);
      logUser(state, "message", event.payload.text);
      appendUserBlock(
        state,
        { type: "text", text: renderUserMessage(event.payload.text) },
        event.seq,
      );
      // New information from the user: the model deserves a fresh start on its counters.
      state.noProgressStreak = 0;
      state.repeat = { signature: null, name: "", count: 0, nudged: false };
      if (state.waiting?.kind === "review_tie_break") {
        state.waiting = null;
        state.reviewWaived = true;
      }
      break;

    case "nudge":
      appendUserBlock(state, { type: "text", text: renderNotice(event.payload.text) }, event.seq);
      if (event.payload.reason === "repetition") state.repeat.nudged = true;
      if (state.pending !== null && state.pending.toolCalls.length === 0) {
        // The turn had no tool call: the nudge is how the harness answered it.
        state.noProgressStreak += 1;
        state.pending = null;
      }
      break;

    case "finish_attempt": {
      const { callId, accepted, rejectionReasons, summary, evidence, handedToUser } = event.payload;
      if (callId !== undefined) {
        state.finishAttempts.set(callId, {
          accepted,
          reasons: [...rejectionReasons],
          handedToUser: handedToUser === true,
        });
      }
      if (accepted) state.acceptedFinish = { summary, evidence: structuredClone(evidence) };
      break;
    }

    case "review":
      state.sideResponse = null;
      state.currentReview = event.payload;
      if (event.payload.verdict === "reject" && event.payload.warning === undefined) {
        state.reviewRejections += 1;
        state.lastRejectionNotes = event.payload.notes;
      }
      break;

    case "escalated":
      logUser(state, "question", event.payload.question);
      state.waiting =
        event.payload.callId !== undefined
          ? { kind: "escalate", callId: event.payload.callId, question: event.payload.question }
          : { kind: "review_tie_break", question: event.payload.question };
      break;

    case "status_changed":
      for (const id of event.payload.inboxIds ?? []) state.deliveredInbox.add(id);
      state.status = event.payload.to;
      state.statusDetail = {
        ...(event.payload.failure === undefined ? {} : { failure: event.payload.failure }),
        ...(event.payload.result === undefined ? {} : { result: event.payload.result }),
      };
      if (event.payload.to === "done" || event.payload.to === "failed") {
        state.acceptedFinish = null;
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
    args: clip(canonicalJson(call.args), 200),
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
