import type { Bot, Conversation, Memory, Message, Run, RunEvent } from "@suup/api";

/** Where the connection to the server is (what the realtime stream says, nothing more). */
export type ConnectionPhase =
  | "offline" // not configured, or never connected
  | "connecting"
  | "online"
  | "reconnecting"
  | "refused"; // the server refused for good (wrong token, origin not allowed)

export interface Connection {
  phase: ConnectionPhase;
  detail?: string;
}

/** A message as the screen holds it: the server's, or one that is still being sent. */
export type LocalMessage = Message & {
  /** Only on an optimistic message: it has not been confirmed by the server yet. */
  local?: "sending";
};

export interface MessagesSlice {
  byId: Record<string, LocalMessage>;
  /** There are older messages than the oldest one held. */
  hasOlder: boolean;
  /** The newest page was fetched at least once. */
  loaded: boolean;
}

export interface EventsSlice {
  bySeq: Record<number, RunEvent>;
  loaded: boolean;
}

/**
 * Everything the app draws, as the server told it. Updated only by explicit fetches and by stream
 * events, through the pure reducers in `reducers.ts`. It holds no business rule about runs.
 */
export interface DataState {
  connection: Connection;
  bots: Record<string, Bot>;
  botsLoaded: boolean;
  conversations: Record<string, Conversation>;
  messages: Record<string, MessagesSlice>;
  runs: Record<string, Run>;
  events: Record<string, EventsSlice>;
  memories: Record<string, Memory>;
  memoriesLoaded: boolean;
}

export const emptyData = (): DataState => ({
  connection: { phase: "offline" },
  bots: {},
  botsLoaded: false,
  conversations: {},
  messages: {},
  runs: {},
  events: {},
  memories: {},
  memoriesLoaded: false,
});

export const emptyMessages = (): MessagesSlice => ({ byId: {}, hasOlder: false, loaded: false });
export const emptyEvents = (): EventsSlice => ({ bySeq: {}, loaded: false });
