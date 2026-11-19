import type {
  Approval,
  ApprovalRule,
  Bot,
  BotNetwork,
  Connector,
  Conversation,
  Memory,
  Message,
  Run,
  RunEvent,
  Secret,
  VaultStatus,
} from "@suup/api";

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
  /** The approval cards, by id: the pending ones and the ones already decided that were fetched. */
  approvals: Record<string, Approval>;
  approvalsLoaded: boolean;
  /** The user's permanent approval rules, by id (no stream frame: read again after writing). */
  rules: Record<string, ApprovalRule>;
  rulesLoaded: boolean;
  /** The vault: secret NAMES and metadata, never a value. By name. */
  secrets: Record<string, Secret>;
  secretsLoaded: boolean;
  /** Whether the server can write secrets (`null`: not asked yet). */
  vault: VaultStatus | null;
  /** The MCP connectors, by name. */
  connectors: Record<string, Connector>;
  connectorsLoaded: boolean;
  /** What each bot's machine may reach (the server's answer to the last read or write), by bot id. */
  networks: Record<string, BotNetwork>;
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
  approvals: {},
  approvalsLoaded: false,
  rules: {},
  rulesLoaded: false,
  secrets: {},
  secretsLoaded: false,
  vault: null,
  connectors: {},
  connectorsLoaded: false,
  networks: {},
});

export const emptyMessages = (): MessagesSlice => ({ byId: {}, hasOlder: false, loaded: false });
export const emptyEvents = (): EventsSlice => ({ bySeq: {}, loaded: false });
