import type { Approval, MessageAttachment, Question, Run, TeamProposal } from "@suup/api";
import { failureLine } from "../../data/derive.js";
import type { SecretRequestItem } from "../../data/secret-requests.js";
import type { LocalMessage } from "../../data/state.js";
import type { BubblePosition, UserMessageState } from "../../ui/message.js";

export type TimelineItem =
  | { kind: "separator"; key: string; text: string }
  | { kind: "user"; key: string; text: string; state: UserMessageState }
  | {
      kind: "bot";
      key: string;
      text: string;
      /** Present when the message is a question: what was asked, and whether it is still waiting. */
      ask?: {
        questions: readonly Question[];
        /** The text of the user's reply, once there is one (it can be a message still being sent). */
        answer: string | undefined;
        /** The run still waits for the reply. */
        open: boolean;
        tieBreak: boolean;
        /**
         * What the bot wrote besides the question (`message.question.lead`, from the server), for a
         * bubble above the card; absent when the bot only asked: the card, titled by the question.
         */
        lead?: string;
      };
    }
  /** The files the bot handed over with the message just before (`send_file`): one card each. */
  | { kind: "files"; key: string; files: readonly MessageAttachment[] }
  /** The main bot's proposal of a team of bots: the card where the user ticks which to create. */
  | { kind: "team"; key: string; messageId: string; text: string; team: TeamProposal }
  /** An approval: the decision card while it waits for the user; decided, its one line. */
  | { kind: "approval"; key: string; approval: Approval }
  /** The bot asked for a credential: the secure form (or, once answered, one line). */
  | { kind: "secret"; key: string; request: SecretRequestItem }
  /** A run that failed or was cancelled: one line that expands in place. */
  | { kind: "ended"; key: string; runId: string; text: string }
  | { kind: "notice"; key: string; text: string }
  /** The run is working (or waits for you): the last thing in the chat is the bot's live avatar. */
  | { kind: "working"; key: string; runId: string };

const GAP_MS = 30 * 60_000;
/**
 * The statuses with the live avatar at the end of the chat: working, and waiting for the user (an
 * approval, an answer). Never a run parked until the return it scheduled: that has no mark.
 */
const LIVE: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
]);

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Hoje", "Ontem" or the date, plus the time: the line that opens a day. */
export function dayLabel(date: Date, now: Date): string {
  const diff = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  const day =
    diff === 0
      ? "Hoje"
      : diff === 1
        ? "Ontem"
        : date.toLocaleDateString("pt-BR", {
            day: "numeric",
            month: "short",
            ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
          });
  return `${day} · ${timeOf(date)}`;
}

/**
 * What the chat draws: the RESULTS only (owner, 24/11/2026: "quero o resultado com excelência e nada
 * mais"). The bot's messages, the files it handed over, its questions, the approval cards and the
 * secure forms (they need you), a team proposal, one line when a run failed or was cancelled, and,
 * while a run works, its live avatar at the end. The tool calls and the steps are never rows: they
 * live in the Inspector.
 */
export function buildTimeline(
  messages: readonly LocalMessage[],
  runs: Record<string, Run>,
  now: Date,
  /** The approvals of the conversation and the secure forms of the run, placed when they were asked. */
  extras: {
    approvals?: readonly Approval[];
    secrets?: readonly SecretRequestItem[];
  } = {},
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const opened = new Set<string>();
  // The cards that need (or needed) you, in the order they were asked.
  type Placed =
    | { kind: "approval"; at: string; runId: string; approval: Approval }
    | { kind: "secret"; at: string; runId: string; request: SecretRequestItem };
  const waiting: Placed[] = [
    ...(extras.approvals ?? []).map(
      (approval): Placed => ({
        kind: "approval",
        at: approval.createdAt,
        runId: approval.runId,
        approval,
      }),
    ),
    ...(extras.secrets ?? []).map(
      (request): Placed => ({
        kind: "secret",
        at: request.startedAt,
        runId: request.runId,
        request,
      }),
    ),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let previous: Date | undefined;

  // The cards due before `until` (all that remains, when `until` is undefined).
  const flush = (until?: string) => {
    while (waiting.length > 0) {
      const next = waiting[0] as Placed;
      const ready = opened.has(next.runId) || until === undefined;
      if (!ready || (until !== undefined && next.at > until)) break;
      waiting.shift();
      if (next.kind === "approval")
        items.push({
          kind: "approval",
          key: `approval-${next.approval.id}`,
          approval: next.approval,
        });
      else
        items.push({
          kind: "secret",
          key: `secret-${next.request.callId}`,
          request: next.request,
        });
    }
  };

  messages.forEach((message, index) => {
    const at = new Date(message.createdAt);
    if (message.local === undefined) {
      flush(message.createdAt);
      if (previous === undefined || dayStart(previous) !== dayStart(at)) {
        items.push({ kind: "separator", key: `sep-${message.id}`, text: dayLabel(at, now) });
      } else if (at.getTime() - previous.getTime() >= GAP_MS) {
        items.push({ kind: "separator", key: `sep-${message.id}`, text: timeOf(at) });
      }
      previous = at;
    }
    const run = message.runId === null ? undefined : runs[message.runId];
    if (message.authorKind === "user") {
      const state: UserMessageState =
        message.local !== undefined
          ? "sending"
          : message.status === "sent"
            ? "sent"
            : message.status === "delivered"
              ? "delivered"
              : undefined;
      items.push({ kind: "user", key: message.id, text: message.text, state });
      if (message.runId !== null && message.local === undefined) opened.add(message.runId);
    } else if (message.authorKind === "system") {
      if (run !== undefined && run.status === "failed") {
        items.push({
          kind: "ended",
          key: message.id,
          runId: run.id,
          text: failureLine(run.failureOrigin),
        });
      } else if (run !== undefined && run.status === "cancelled") {
        items.push({ kind: "ended", key: message.id, runId: run.id, text: "Execução cancelada" });
      } else {
        items.push({ kind: "notice", key: message.id, text: message.text });
      }
    } else if (message.team !== undefined) {
      items.push({
        kind: "team",
        key: message.id,
        messageId: message.id,
        text: message.text,
        team: message.team,
      });
    } else if (message.question === undefined) {
      items.push({ kind: "bot", key: message.id, text: message.text });
    } else {
      // The reply is the next message of the user, even one still being sent: the card answers at once.
      const reply = messages.slice(index + 1).find((m) => m.authorKind === "user");
      items.push({
        kind: "bot",
        key: message.id,
        text: message.text,
        ask: {
          questions: message.question.questions,
          answer: reply?.text,
          open: reply === undefined && run?.status === "waiting_user",
          tieBreak: message.question.reason === "review_tie_break",
          // What the bot wrote besides the question, as the server declares it (never compared).
          ...(message.question.lead === undefined ? {} : { lead: message.question.lead }),
        },
      });
    }
    // The files of a bot (or system) message: right under it, apart from the bubble.
    if (message.authorKind !== "user" && message.attachments !== undefined) {
      items.push({ kind: "files", key: `${message.id}-files`, files: message.attachments });
    }
  });
  // Whatever is left (the run is still working, or no message opened it).
  flush();

  const working = Object.values(runs).find(
    (r) => LIVE.has(r.status) && messages.some((m) => m.runId === r.id),
  );
  if (working !== undefined)
    items.push({ kind: "working", key: `working-${working.id}`, runId: working.id });
  return items;
}

/** A bot message that is a card (a question with choices) and not an ordinary text bubble. */
export function isChoiceCard(item: TimelineItem): boolean {
  return item.kind === "bot" && item.ask?.questions.some((q) => q.options !== undefined) === true;
}

/** The sender of a text bubble, or null for anything that is not one (cards, lines, separators). */
function bubbleSender(item: TimelineItem): "user" | "bot" | null {
  if (item.kind === "user") return "user";
  // A question with choices is the card alone, or (when the bot wrote more than the question) its
  // bubble and, under it, the card.
  if (item.kind === "bot") return isChoiceCard(item) && item.ask?.lead === undefined ? null : "bot";
  return null;
}

/**
 * The groups of consecutive text bubbles from the same sender, by item key. Anything that is not a
 * text bubble (a card, an action row, a separator — which is also what a long time gap becomes —,
 * a notice, the working indicator) breaks the group and is not in the result. A question with
 * choices is the card alone (not in the result), or, when the bot wrote more than the question, a
 * bubble followed by the card, so that bubble is the LAST of its group. Pure: the component
 * only reads the position.
 */
export function bubblePositions(items: readonly TimelineItem[]): Map<string, BubblePosition> {
  const result = new Map<string, BubblePosition>();
  let run: string[] = [];
  let sender: "user" | "bot" | null = null;
  const close = () => {
    run.forEach((key, i) => {
      result.set(
        key,
        run.length === 1 ? "single" : i === 0 ? "first" : i === run.length - 1 ? "last" : "middle",
      );
    });
    run = [];
  };
  for (const item of items) {
    const who = bubbleSender(item);
    if (who === null || who !== sender) close();
    sender = who;
    if (who !== null) run.push(item.key);
    // The card goes right under the bubble of the bot's words: it ends the group.
    if (isChoiceCard(item)) {
      close();
      sender = null;
    }
  }
  close();
  return result;
}
