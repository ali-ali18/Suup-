import type {
  Bot,
  Conversation,
  Memory,
  Message,
  Run,
  RunEvent,
  RunStatus,
  StreamEvent,
} from "@suup/api";
import {
  type Connection,
  type DataState,
  type EventsSlice,
  emptyEvents,
  emptyMessages,
  type LocalMessage,
  type MessagesSlice,
} from "./state.js";

// Pure reducers: `(state, input) => state`. Same object back when nothing changed (so React does
// not redraw). Every merge is idempotent and refuses to go back in time: the same frame twice, or a
// REST answer that arrives after a newer stream frame, changes nothing.

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled"]);
export const isTerminal = (status: RunStatus): boolean => TERMINAL.has(status);

/** ISO 8601 UTC strings compare correctly as text. */
const newerOrEqual = (incoming: string, current: string): boolean => incoming >= current;

/**
 * Should `incoming` replace `current`? A finished run is never replaced by an unfinished one (a
 * status never goes backwards), and otherwise the later `updatedAt` wins (a tie takes the incoming:
 * frames arrive in order, and the same version twice is the same data).
 */
export function runSupersedes(incoming: Run, current: Run | undefined): boolean {
  if (current === undefined) return true;
  if (isTerminal(current.status) && !isTerminal(incoming.status)) return false;
  if (isTerminal(incoming.status) && !isTerminal(current.status)) return true;
  if (incoming.updatedAt !== current.updatedAt)
    return newerOrEqual(incoming.updatedAt, current.updatedAt);
  return incoming.turns >= current.turns;
}

export function mergeRun(state: DataState, run: Run): DataState {
  if (!runSupersedes(run, state.runs[run.id])) return state;
  if (state.runs[run.id] !== undefined && sameJson(state.runs[run.id], run)) return state;
  return { ...state, runs: { ...state.runs, [run.id]: run } };
}

export function mergeRuns(state: DataState, runs: readonly Run[]): DataState {
  return runs.reduce(mergeRun, state);
}

export function mergeBot(state: DataState, bot: Bot): DataState {
  const current = state.bots[bot.id];
  if (current !== undefined && !newerOrEqual(bot.updatedAt, current.updatedAt)) return state;
  if (current !== undefined && sameJson(current, bot)) return state;
  return { ...state, bots: { ...state.bots, [bot.id]: bot } };
}

/** The result of a full `GET /v1/bots`: replaces the set (a bot archived elsewhere disappears). */
export function setBots(state: DataState, bots: readonly Bot[]): DataState {
  let next: DataState = { ...state, botsLoaded: true, bots: {} };
  for (const bot of bots) {
    const current = state.bots[bot.id];
    // Keep a newer bot the stream delivered while the request was on its way.
    next = {
      ...next,
      bots: {
        ...next.bots,
        [bot.id]: current !== undefined && current.updatedAt > bot.updatedAt ? current : bot,
      },
    };
  }
  return next;
}

export function mergeConversation(state: DataState, conversation: Conversation): DataState {
  const current = state.conversations[conversation.id];
  if (current !== undefined && !newerOrEqual(conversation.updatedAt, current.updatedAt)) {
    return state;
  }
  if (current !== undefined && sameJson(current, conversation)) return state;
  let next: DataState = {
    ...state,
    conversations: { ...state.conversations, [conversation.id]: conversation },
  };
  // The conversation carries the run in the foreground: keep it in the run table too.
  if (conversation.activeRun !== null) next = mergeRun(next, conversation.activeRun);
  return next;
}

export function mergeConversations(state: DataState, items: readonly Conversation[]): DataState {
  return items.reduce(mergeConversation, state);
}

// ---------------------------------------------------------------- messages

function sliceOf(state: DataState, conversationId: string): MessagesSlice {
  return state.messages[conversationId] ?? emptyMessages();
}

function withSlice(state: DataState, conversationId: string, slice: MessagesSlice): DataState {
  return { ...state, messages: { ...state.messages, [conversationId]: slice } };
}

/** A message never goes from `delivered` back to `sent`; anything else is the server's word. */
function mergeMessageValue(current: LocalMessage | undefined, incoming: Message): Message {
  if (current === undefined) return incoming;
  if (current.status === "delivered" && incoming.status === "sent") {
    return { ...incoming, status: "delivered" };
  }
  return incoming;
}

export function upsertMessage(state: DataState, message: Message): DataState {
  const slice = sliceOf(state, message.conversationId);
  const current = slice.byId[message.id];
  const merged = mergeMessageValue(current, message);
  if (current !== undefined && current.local === undefined && sameJson(current, merged)) {
    return state;
  }
  return withSlice(state, message.conversationId, {
    ...slice,
    byId: { ...slice.byId, [message.id]: merged },
  });
}

/**
 * A page fetched by REST. `direction` says which end of the held window it extends: `newest` (the
 * first load or a reload: replaces nothing, but its `hasMore` tells whether older ones exist),
 * `older` (scrolling up), `newer` (catching up after a gap).
 */
export function mergeMessagePage(
  state: DataState,
  conversationId: string,
  items: readonly Message[],
  hasMore: boolean,
  direction: "newest" | "older" | "newer",
): DataState {
  const slice = sliceOf(state, conversationId);
  const byId = { ...slice.byId };
  for (const message of items) byId[message.id] = mergeMessageValue(byId[message.id], message);
  let hasOlder = slice.hasOlder;
  if (direction === "older") hasOlder = hasMore;
  else if (direction === "newest") {
    // The window may have a hole between its old content and this page: drop what is older than
    // the page's first message when more exist, so the hole cannot be mistaken for history.
    const first = items[0];
    if (first !== undefined && hasMore) {
      for (const [id, m] of Object.entries(byId)) {
        if (m.local === undefined && m.seq < first.seq) delete byId[id];
      }
    }
    hasOlder = hasMore;
  }
  return withSlice(state, conversationId, { byId, hasOlder, loaded: true });
}

/** Messages in display order: by `seq`, then the ones still being sent, in the order sent. */
const orderCache = new WeakMap<MessagesSlice, LocalMessage[]>();
export function orderedMessages(slice: MessagesSlice | undefined): LocalMessage[] {
  if (slice === undefined) return [];
  const cached = orderCache.get(slice);
  if (cached !== undefined) return cached;
  const all = Object.values(slice.byId);
  const confirmed = all.filter((m) => m.local === undefined).sort((a, b) => a.seq - b.seq);
  const pending = all
    .filter((m) => m.local !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const result = [...confirmed, ...pending];
  orderCache.set(slice, result);
  return result;
}

export const OPTIMISTIC_PREFIX = "local:";

/** Shows a message at once, before the server confirms it. */
export function addOptimisticMessage(
  state: DataState,
  input: { tempId: string; conversationId: string; text: string; now: string },
): DataState {
  const slice = sliceOf(state, input.conversationId);
  const message: LocalMessage = {
    id: `${OPTIMISTIC_PREFIX}${input.tempId}`,
    conversationId: input.conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    authorKind: "user",
    authorBotId: null,
    text: input.text,
    runId: null,
    status: null,
    createdAt: input.now,
    local: "sending",
  };
  return withSlice(state, input.conversationId, {
    ...slice,
    byId: { ...slice.byId, [message.id]: message },
  });
}

/** The server confirmed: the temporary message becomes the real one (which may already be here). */
export function resolveOptimisticMessage(
  state: DataState,
  tempId: string,
  message: Message,
): DataState {
  const slice = sliceOf(state, message.conversationId);
  const { [`${OPTIMISTIC_PREFIX}${tempId}`]: _gone, ...rest } = slice.byId;
  return upsertMessage(withSlice(state, message.conversationId, { ...slice, byId: rest }), message);
}

/** The server refused: the temporary message disappears (the caller gives the text back). */
export function rollbackOptimisticMessage(
  state: DataState,
  conversationId: string,
  tempId: string,
): DataState {
  const slice = sliceOf(state, conversationId);
  const id = `${OPTIMISTIC_PREFIX}${tempId}`;
  if (slice.byId[id] === undefined) return state;
  const { [id]: _gone, ...rest } = slice.byId;
  return withSlice(state, conversationId, { ...slice, byId: rest });
}

// ------------------------------------------------------------------ events

function eventsOf(state: DataState, runId: string): EventsSlice {
  return state.events[runId] ?? emptyEvents();
}

/** Run events are keyed by `seq`: the same event twice, in any order, is one event. */
export function mergeRunEvents(
  state: DataState,
  runId: string,
  items: readonly RunEvent[],
  options: { loaded?: boolean } = {},
): DataState {
  const slice = eventsOf(state, runId);
  let bySeq = slice.bySeq;
  let changed = false;
  for (const event of items) {
    if (bySeq[event.seq] !== undefined) continue;
    if (!changed) bySeq = { ...bySeq };
    bySeq[event.seq] = event;
    changed = true;
  }
  const loaded = options.loaded ?? slice.loaded;
  if (!changed && loaded === slice.loaded && state.events[runId] !== undefined) return state;
  return { ...state, events: { ...state.events, [runId]: { bySeq, loaded } } };
}

/** The highest `seq` such that every event from 1 to it is held: where a fetch resumes. */
export function contiguousSeq(slice: EventsSlice | undefined): number {
  if (slice === undefined) return 0;
  let seq = 0;
  while (slice.bySeq[seq + 1] !== undefined) seq += 1;
  return seq;
}

export function orderedEvents(slice: EventsSlice | undefined): RunEvent[] {
  if (slice === undefined) return [];
  return Object.values(slice.bySeq).sort((a, b) => a.seq - b.seq);
}

// ------------------------------------------------------------------ memory

export function mergeMemory(state: DataState, memory: Memory): DataState {
  const current = state.memories[memory.id];
  if (current !== undefined && !newerOrEqual(memory.updatedAt, current.updatedAt)) return state;
  if (current !== undefined && sameJson(current, memory)) return state;
  return { ...state, memories: { ...state.memories, [memory.id]: memory } };
}

export function setMemories(state: DataState, items: readonly Memory[]): DataState {
  const memories: Record<string, Memory> = {};
  for (const memory of items) {
    const current = state.memories[memory.id];
    memories[memory.id] =
      current !== undefined && current.updatedAt > memory.updatedAt ? current : memory;
  }
  return { ...state, memories, memoriesLoaded: true };
}

// -------------------------------------------------------------- connection

export function setConnection(state: DataState, connection: Connection): DataState {
  const current = state.connection;
  if (current.phase === connection.phase && current.detail === connection.detail) return state;
  return { ...state, connection };
}

// ------------------------------------------------------------------ stream

/** What one stream frame does to the state. `ready` and `resync` are for the sync layer. */
export function applyStreamEvent(state: DataState, event: StreamEvent): DataState {
  switch (event.type) {
    case "run.event":
      return mergeRunEvents(state, event.data.runId, [event.data.event]);
    case "run.updated":
      return mergeRun(state, event.data.run);
    case "message.created":
    case "message.updated":
      return upsertMessage(state, event.data.message);
    case "conversation.updated":
      return mergeConversation(state, event.data.conversation);
    case "memory.changed":
      return mergeMemory(state, event.data.memory);
    case "bot.updated":
      return mergeBot(state, event.data.bot);
    case "approval.changed":
      // The approval cards have no screen yet (they come with the desktop work of phase 3).
      return state;
    case "ready":
    case "resync":
      return state;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
