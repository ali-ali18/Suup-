import type { Approval, Run, RunEvent } from "@suup/api";

// The connect cards of the chat (owner, 24/11/2026: "ele deveria ter usado um card!!!"): what a bot
// hands over when something is missing to do the work (log in, authorize an app, give access, add a
// key, or just open the plugin). Read from DECLARED data only: the arguments of the bot's
// `show_connect_card` call, and the `connector` of its `propose_connector` call, each kept only when
// the tool answered without an error (the server checks the link before it answers). Nothing is read
// from a message text, and a link is never looked for in one.

export const SHOW_CONNECT_CARD = "show_connect_card";
export const PROPOSE_CONNECTOR = "propose_connector";

export type ConnectCardAction = "connect" | "authorize_app" | "grant" | "add_key" | "manage";
const ACTIONS: ReadonlySet<string> = new Set([
  "connect",
  "authorize_app",
  "grant",
  "add_key",
  "manage",
]);

export interface ConnectCardItem {
  /** The tool call, unique in the conversation. */
  callId: string;
  runId: string;
  /** The bot the card is about (the one that may be given access). */
  botId: string;
  /** When the call was made (ISO), to place the card among the messages. */
  at: string;
  /** The name of the installed connector. */
  connector: string;
  /** The app inside the connector ("Google Agenda"), when the bot named one. */
  app?: string;
  /** The link the connector handed out, already checked by the server (a secure address, a declared host). */
  url?: string;
  /** When the link stops working (ISO), if the service said. */
  expiresAt?: string;
  action: ConnectCardAction;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The cards one run asked for, in order. */
export function connectCardsOf(
  run: Pick<Run, "id" | "botId">,
  events: readonly RunEvent[],
): ConnectCardItem[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown>; at: string }>();
  const failed = new Set<string>();
  const done: string[] = [];
  for (const event of events) {
    const p = event.payload;
    if (event.type === "tool_call") {
      const callId = str(p.callId);
      const name = str(p.name);
      if (callId === undefined || (name !== SHOW_CONNECT_CARD && name !== PROPOSE_CONNECTOR))
        continue;
      calls.set(callId, { name, args: record(p.args), at: event.createdAt });
    } else if (event.type === "tool_result") {
      const callId = str(p.callId);
      if (callId === undefined || !calls.has(callId)) continue;
      if (p.isError === true) failed.add(callId);
      else done.push(callId);
    }
  }
  const items: ConnectCardItem[] = [];
  for (const callId of done) {
    if (failed.has(callId)) continue;
    const call = calls.get(callId);
    const connector = str(call?.args.connector);
    if (call === undefined || connector === undefined) continue;
    const declared = str(call.args.action);
    const action: ConnectCardAction =
      call.name === SHOW_CONNECT_CARD && declared !== undefined && ACTIONS.has(declared)
        ? (declared as ConnectCardAction)
        : "connect";
    const app = call.name === SHOW_CONNECT_CARD ? str(call.args.app) : undefined;
    const url = call.name === SHOW_CONNECT_CARD ? str(call.args.url) : undefined;
    const expiresAt = call.name === SHOW_CONNECT_CARD ? str(call.args.expiresAt) : undefined;
    items.push({
      callId,
      runId: run.id,
      botId: run.botId,
      at: call.at,
      connector,
      action,
      ...(app === undefined ? {} : { app }),
      ...(url === undefined ? {} : { url }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }
  return items;
}

/** An approved proposal whose run events are not loaded: the card from the approval's own arguments. */
export function connectCardOfApproval(approval: Approval): ConnectCardItem | undefined {
  if (approval.tool !== PROPOSE_CONNECTOR || approval.status !== "approved") return undefined;
  const connector = str(record(approval.args).connector);
  if (connector === undefined) return undefined;
  return {
    callId: approval.callId,
    runId: approval.runId,
    botId: approval.botId,
    at: approval.createdAt,
    connector,
    action: "connect",
  };
}

/**
 * Every card of a conversation: those of the runs whose events are loaded, plus, for an approved
 * proposal of a run that is not, the one the approval itself gives. Sorted by when they were asked.
 */
export function connectCardsOfConversation(
  runs: readonly Run[],
  eventsByRun: Readonly<Record<string, readonly RunEvent[] | undefined>>,
  approvals: readonly Approval[],
): ConnectCardItem[] {
  const out: ConnectCardItem[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const events = eventsByRun[run.id];
    if (events === undefined) continue;
    for (const card of connectCardsOf(run, events)) {
      seen.add(card.callId);
      out.push(card);
    }
  }
  for (const approval of approvals) {
    const card = connectCardOfApproval(approval);
    if (card !== undefined && !seen.has(card.callId)) out.push(card);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Whether an approval is the proposal of a connector that was approved: the card replaces its row. */
export const isApprovedProposal = (approval: Pick<Approval, "tool" | "status">): boolean =>
  approval.tool === PROPOSE_CONNECTOR && approval.status === "approved";
