import type { Run, RunEvent } from "@suup/api";
import type { TurnLead } from "./turn-lead.js";

// The bot's request for a credential (`request_secret`), as the chat draws it: from the run's events
// (`secret_requested`, then the `tool_result` that answers it). Nothing here ever holds a value: the
// log has only the NAME and the reason the bot gave, and the answer says only that the secret is
// available (or that the person declined).

export type SecretRequestState =
  /** The run waits for the person: the secure form is shown. */
  | "open"
  /** Answered with a value: the secret is in the vault and granted to the bot. */
  | "provided"
  | "declined"
  /** The run ended without an answer (cancelled, or failed). */
  | "closed";

export interface SecretRequestItem {
  callId: string;
  runId: string;
  name: string;
  reason: string | null;
  /** The sites the bot SUGGESTED (a suggestion only: the form shows them to be confirmed). */
  hosts: string[];
  /** When it was asked (ISO), to place the card among the messages. */
  startedAt: string;
  state: SecretRequestState;
  /** What the bot said in the turn of the call (`secret_requested.lead`): drawn above the form. */
  lead?: TurnLead;
  /**
   * The `dedupeKey` of the message the end of the run writes with that same lead (see
   * `run-end.ts`): the chat draws the words once, above the form, and skips that message.
   */
  messageKey: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The text the server gives the model when the person declines (`answerSecretRequest`); the result
 * of the `request_secret` call is that text, so it is how a reloaded chat tells the two apart.
 */
export const DECLINED_PREFIX = "The user declined";

/** One item per `secret_requested` of the run, in order. */
export function secretRequestsOf(
  run: Pick<Run, "id" | "status"> | undefined,
  runId: string,
  events: readonly RunEvent[],
): SecretRequestItem[] {
  const items: SecretRequestItem[] = [];
  const byCall = new Map<string, SecretRequestItem>();
  for (const event of events) {
    const p = event.payload;
    if (event.type === "secret_requested") {
      const callId = str(p.callId);
      const name = str(p.name);
      if (callId === undefined || name === undefined || byCall.has(callId)) continue;
      const lead = str(p.lead)?.trim() ?? "";
      const item: SecretRequestItem = {
        callId,
        runId,
        name,
        reason: str(p.reason) ?? null,
        hosts: Array.isArray(p.hosts)
          ? p.hosts.filter((host): host is string => typeof host === "string")
          : [],
        startedAt: event.createdAt,
        messageKey: `run:${runId}:secret:${event.seq}`,
        ...(lead === "" ? {} : { lead: { text: lead, turn: `secret:${callId}` } }),
        state: run?.status === "waiting_user" ? "open" : "closed",
      };
      byCall.set(callId, item);
      items.push(item);
    } else if (event.type === "tool_result") {
      const item = byCall.get(str(p.callId) ?? "");
      if (item === undefined) continue;
      item.state = (str(p.content) ?? "").startsWith(DECLINED_PREFIX) ? "declined" : "provided";
    } else if (event.type === "escalated") {
      // A later question: an earlier request still open is not the one the run waits for.
      for (const open of items) if (open.state === "open") open.state = "closed";
    }
  }
  // Only the last request can be the one the run waits for.
  const last = items[items.length - 1];
  for (const item of items) if (item !== last && item.state === "open") item.state = "closed";
  return items;
}

/** The request the run waits for right now, if it is a request for a secret. */
export function openSecretRequest(
  run: Pick<Run, "id" | "status"> | undefined,
  runId: string,
  events: readonly RunEvent[],
): SecretRequestItem | undefined {
  return secretRequestsOf(run, runId, events).find((i) => i.state === "open");
}

export const SECRET_LINE: Record<SecretRequestState, string> = {
  open: "Aguardando o valor",
  provided: "Segredo disponível",
  declined: "Você recusou",
  closed: "Pedido encerrado",
};
