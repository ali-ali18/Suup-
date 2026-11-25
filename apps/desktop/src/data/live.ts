// The answer being typed (KOD-34, docs/pesquisas/kod-34-texto-ao-vivo.md). The server sends the
// text as ephemeral frames; this keeps what arrived and decides which bubble it is, until the
// recorded message takes its place. Nothing here is a message: it never enters `messages`, is never
// saved, and is never sent anywhere. All pure: the time comes in as an argument.
//
// Identity: a bubble is `run + call + block`. `call` is the position (`seq`) of the call's request
// in the run's log; `block` is which shown text of the call it is. The recorded message that
// replaces it is found by positions only, never by comparing text:
// - a part (`message.eventSeq` = the `seq` of the response) takes the earliest unresolved block of
//   the newest call before that `seq`;
// - the end message (no `eventSeq`: the answer, a question, a return) takes the newest call's block.
import type { Message, Run, StreamEvent } from "@suup/api";
import type { DataState } from "./state.js";

/**
 * The one rule that depends on time: a bubble whose recorded message has not arrived is thrown away
 * this long after it can no longer be the one being written (the run moved on to a newer call, or
 * stopped working). A message that arrives sooner replaces it; a text that never gets one (a turn
 * that was sent back, a refused `finish`) vanishes.
 */
export const LIVE_SETTLE_MS = 3_000;

/** At most this many bubbles are remembered (the old resolved ones are forgotten first). */
const LIVE_KEEP = 400;

export interface LiveBlock {
  runId: string;
  call: number;
  block: number;
  attempt: number;
  /** What arrived so far (scrubbed by the server). Empty once dropped. */
  text: string;
  /** `typing`: shown. `resolved`: a recorded message took its place (`messageId`). `dropped`: gone. */
  state: "typing" | "resolved" | "dropped";
  messageId?: string;
  /** Thrown away at this time (ms) if still unresolved. */
  settleAt?: number;
  /** The call's last frame was `recorded`: no more text comes for it. */
  ended?: boolean;
  /** Order of arrival, to forget the oldest. */
  order: number;
}

export const liveKey = (runId: string, call: number, block: number): string =>
  `${runId}:${call}:${block}`;

const RUNNING: ReadonlySet<Run["status"]> = new Set(["queued", "running"]);

let counter = 0;

function put(state: DataState, key: string, block: LiveBlock): DataState {
  let live = { ...state.live, [key]: block };
  const keys = Object.keys(live);
  if (keys.length > LIVE_KEEP) {
    const forget = keys
      .filter((k) => live[k]?.state !== "typing")
      .sort((a, b) => (live[a]?.order ?? 0) - (live[b]?.order ?? 0))
      .slice(0, keys.length - LIVE_KEEP);
    if (forget.length > 0) {
      live = Object.fromEntries(Object.entries(live).filter(([k]) => !forget.includes(k)));
    }
  }
  return { ...state, live };
}

/** Marks the unresolved bubbles of calls older than `call` (of that run) to be thrown away soon. */
function settleOlder(state: DataState, runId: string, call: number, now: number): DataState {
  let next = state;
  for (const [key, b] of Object.entries(state.live)) {
    if (b.runId === runId && b.call < call && b.state === "typing" && b.settleAt === undefined) {
      next = put(next, key, { ...b, settleAt: now + LIVE_SETTLE_MS });
    }
  }
  return next;
}

type LiveText = Extract<StreamEvent, { type: "live.text" }>["data"];
type LiveEnd = Extract<StreamEvent, { type: "live.end" }>["data"];

function applyText(state: DataState, f: LiveText, now: number): DataState {
  const key = liveKey(f.runId, f.call, f.block);
  const current = state.live[key];
  // A call that came after: what was typed before is no longer the one being written.
  const base = settleOlder(state, f.runId, f.call, now);
  if (current !== undefined) {
    if (current.attempt > f.attempt) return base; // a frame of an attempt that is over
    if (current.attempt === f.attempt && current.state !== "typing") return base; // resolved or gone
  }
  const sameAttempt = current !== undefined && current.attempt === f.attempt;
  let text: string;
  if (f.offset === 0)
    text = f.text; // the start, or a snapshot: it replaces what we have
  else if (sameAttempt && f.offset === current.text.length) text = current.text + f.text;
  else return base; // a hole: wait for the next snapshot
  return put(base, key, {
    runId: f.runId,
    call: f.call,
    block: f.block,
    attempt: f.attempt,
    text,
    state: "typing",
    ...(current?.ended === true && sameAttempt ? { ended: true } : {}),
    order: current?.order ?? ++counter,
  });
}

function applyEnd(state: DataState, f: LiveEnd): DataState {
  let next = state;
  for (const [key, b] of Object.entries(state.live)) {
    if (b.runId !== f.runId || b.call !== f.call || b.attempt > f.attempt) continue;
    if (f.block !== undefined && b.block !== f.block) continue;
    if (b.state === "resolved") continue;
    if (f.outcome === "recorded" && f.block === undefined) {
      next = put(next, key, { ...b, ended: true });
    } else {
      // Dropped, refused, cut off, failed, or a retry: the text typed is thrown away at once.
      next = put(next, key, { ...b, state: "dropped", text: "" });
    }
  }
  return next;
}

/** A recorded message of the bot: it takes the place of the bubble it was typed in, if any. */
function resolve(state: DataState, message: Message): DataState {
  if (message.authorKind !== "bot" || message.runId === null) return state;
  const runId = message.runId;
  const mine = Object.entries(state.live).filter(([, b]) => b.runId === runId);
  if (mine.length === 0) return state;
  if (mine.some(([, b]) => b.messageId === message.id)) return state; // already placed
  const open = mine.filter(([, b]) => b.state === "typing");
  let pool: [string, LiveBlock][];
  if (message.eventSeq !== undefined) {
    const seq = message.eventSeq;
    const calls = open.map(([, b]) => b.call).filter((c) => c < seq);
    if (calls.length === 0) return state;
    const call = Math.max(...calls);
    pool = open.filter(([, b]) => b.call === call).sort((a, b) => a[1].block - b[1].block);
  } else {
    const calls = open.map(([, b]) => b.call);
    if (calls.length === 0) return state;
    const call = Math.max(...calls);
    pool = open.filter(([, b]) => b.call === call).sort((a, b) => a[1].block - b[1].block);
  }
  const first = pool[0];
  if (first === undefined) return state;
  return put(state, first[0], {
    ...first[1],
    state: "resolved",
    messageId: message.id,
  });
}

/** Everything the stream can say about the typed text, applied to the state. */
export function applyLiveEvent(state: DataState, event: StreamEvent, now: number): DataState {
  switch (event.type) {
    case "live.text":
      return applyText(state, event.data, now);
    case "live.end":
      return applyEnd(state, event.data);
    case "message.created":
      return resolve(state, event.data.message);
    case "run.updated": {
      // The run stopped working: what is still unresolved has a few seconds to be replaced.
      const run = event.data.run;
      if (RUNNING.has(run.status)) return state;
      let next = state;
      for (const [key, b] of Object.entries(state.live)) {
        if (b.runId === run.id && b.state === "typing" && b.settleAt === undefined) {
          next = put(next, key, { ...b, settleAt: now + LIVE_SETTLE_MS });
        }
      }
      return next;
    }
    default:
      return state;
  }
}

/** Throws away the unresolved bubbles whose time ran out. Returns the same state if none did. */
export function expireLive(state: DataState, now: number): DataState {
  let next = state;
  for (const [key, b] of Object.entries(state.live)) {
    if (b.state === "typing" && b.settleAt !== undefined && b.settleAt <= now) {
      next = put(next, key, { ...b, state: "dropped", text: "" });
    }
  }
  return next;
}

/** When the next unresolved bubble runs out of time (ms), or `undefined` if none will. */
export function nextLiveExpiry(state: DataState): number | undefined {
  let at: number | undefined;
  for (const b of Object.values(state.live)) {
    if (b.state === "typing" && b.settleAt !== undefined && (at === undefined || b.settleAt < at)) {
      at = b.settleAt;
    }
  }
  return at;
}

/** What the chat draws for the typed text of some runs, and which message took which bubble. */
export interface LiveView {
  /** The bubbles being typed, oldest call first. Only those with something to show. */
  typing: { key: string; runId: string; call: number; text: string }[];
  /** The key of the bubble that a message replaced, by message id: the same element stays. */
  keyOf: Record<string, string>;
}

export function liveView(live: DataState["live"], runIds: ReadonlySet<string>): LiveView {
  const typing: LiveView["typing"] = [];
  const keyOf: Record<string, string> = {};
  for (const [key, b] of Object.entries(live)) {
    if (!runIds.has(b.runId)) continue;
    if (b.state === "resolved" && b.messageId !== undefined) keyOf[b.messageId] = `live-${key}`;
    else if (b.state === "typing" && b.text.trim() !== "") {
      typing.push({ key: `live-${key}`, runId: b.runId, call: b.call, text: b.text.trim() });
    }
  }
  typing.sort((a, b) => a.call - b.call || a.key.localeCompare(b.key));
  return { typing, keyOf };
}
