import type { Approval, Question, Run } from "@suup/api";
import {
  type ActionEntry,
  type ActionItem,
  foldActions,
  mergeApprovals,
  VISIBLE_ACTIONS,
} from "../../data/actions.js";
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
      };
    }
  /** The tool calls made between two messages, as cards (older finished ones folded). */
  | { kind: "actions"; key: string; entries: ActionEntry[] }
  /** An approval that waits for the user: the decision card (a decided one is part of its call's row). */
  | { kind: "approval"; key: string; approval: Approval }
  /** The bot asked for a credential: the secure form (or, once answered, one line). */
  | { kind: "secret"; key: string; request: SecretRequestItem }
  /** A run that failed or was cancelled: one line that expands in place. */
  | { kind: "ended"; key: string; runId: string; text: string }
  | { kind: "notice"; key: string; text: string }
  /** The run is working: the last thing in the chat is the indicator. */
  | { kind: "working"; key: string; runId: string };

const GAP_MS = 30 * 60_000;
const WORKING: ReadonlySet<Run["status"]> = new Set(["queued", "running"]);

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
 * What the chat draws, from the messages, the runs they belong to and the tool calls of the runs.
 * Every tool call of the bot is ONE row in its column (its approval, if it had one, merged into it), placed among the messages by the time it was
 * made; a failure or a cancellation is one line (`ended`); a question is a bot message that carries
 * what was asked; a final answer is an ordinary bot message; a working run ends the list with the
 * indicator.
 */
export function buildTimeline(
  messages: readonly LocalMessage[],
  runs: Record<string, Run>,
  actions: readonly ActionItem[],
  now: Date,
  /** How many of the latest cards stay visible before older finished ones fold (Infinity: never fold). */
  keep: number = VISIBLE_ACTIONS,
  /** The approvals of the conversation and the secure forms of the run, among the actions. */
  extras: {
    approvals?: readonly Approval[];
    secrets?: readonly SecretRequestItem[];
    connectors?: Parameters<typeof mergeApprovals>[2];
  } = {},
): TimelineItem[] {
  // One row per tool call: a decided approval merges into its call; a waiting one is the decision card.
  const merged = mergeApprovals(actions, extras.approvals ?? [], extras.connectors);
  const items: TimelineItem[] = [];
  const opened = new Set<string>();
  // Everything the bot did, in the order it happened: tool calls, approval cards, secure forms.
  type Placed =
    | { kind: "action"; at: string; runId: string; action: ActionItem }
    | { kind: "approval"; at: string; runId: string; approval: Approval }
    | { kind: "secret"; at: string; runId: string; request: SecretRequestItem };
  const waiting: Placed[] = [
    ...merged.calls.map(
      (action): Placed => ({
        kind: "action",
        at: action.startedAt,
        runId: action.runId,
        action,
      }),
    ),
    ...merged.pending.map(
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

  // What is due before `until` (all that remains, when `until` is undefined): the tool calls that
  // follow each other as one group of cards, and each approval card or form on its own.
  const flush = (until?: string) => {
    let group: ActionItem[] = [];
    const closeGroup = () => {
      if (group.length === 0) return;
      items.push({
        kind: "actions",
        key: `actions-${(group[0] as ActionItem).callId}`,
        entries: foldActions(group, keep),
      });
      group = [];
    };
    while (waiting.length > 0) {
      const next = waiting[0] as Placed;
      const ready = opened.has(next.runId) || until === undefined;
      if (!ready || (until !== undefined && next.at > until)) break;
      waiting.shift();
      if (next.kind === "action") group.push(next.action);
      else {
        closeGroup();
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
    }
    closeGroup();
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
        },
      });
    }
  });
  // Whatever is left (the run is still working, or no message opened it).
  flush();

  const working = Object.values(runs).find(
    (r) => WORKING.has(r.status) && messages.some((m) => m.runId === r.id),
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
  if (item.kind === "bot" && !isChoiceCard(item)) return "bot";
  return null;
}

/**
 * The groups of consecutive text bubbles from the same sender, by item key. Anything that is not a
 * text bubble (a card, an action row, a separator — which is also what a long time gap becomes —,
 * a notice, the working indicator) breaks the group and is not in the result. Pure: the component
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
  }
  close();
  return result;
}
