import type { Question, Run } from "@suup/api";
import {
  type ActionEntry,
  type ActionItem,
  foldActions,
  VISIBLE_ACTIONS,
} from "../../data/actions.js";
import { failureLine } from "../../data/derive.js";
import type { LocalMessage } from "../../data/state.js";
import type { UserMessageState } from "../../ui/message.js";

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
 * Every action of the bot is a card in its column, placed among the messages by the time it was
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
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const opened = new Set<string>();
  const waiting = [...actions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let previous: Date | undefined;

  // The cards due before `until` (all that remain, when `until` is undefined), as one group.
  const flush = (until?: string) => {
    const due: ActionItem[] = [];
    while (waiting.length > 0) {
      const next = waiting[0] as ActionItem;
      const ready = opened.has(next.runId) || until === undefined;
      if (!ready || (until !== undefined && next.startedAt > until)) break;
      due.push(next);
      waiting.shift();
    }
    if (due.length > 0) {
      items.push({
        kind: "actions",
        key: `actions-${(due[0] as ActionItem).callId}`,
        entries: foldActions(due, keep),
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
