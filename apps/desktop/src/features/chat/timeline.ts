import type { Approval, MessageAttachment, Question, Run, Task, TeamProposal } from "@suup/api";
import { callSeqKey } from "../../data/call-seq.js";
import type { ConnectCardItem } from "../../data/connect-cards.js";
import { isApprovedProposal } from "../../data/connect-cards.js";
import { failureLine } from "../../data/derive.js";
import type { LiveView } from "../../data/live.js";
import type { SecretRequestItem } from "../../data/secret-requests.js";
import type { LocalMessage } from "../../data/state.js";
import type { BubblePosition, UserMessageState } from "../../ui/message.js";

/** A task a bubble or a card comes from (KOD-68): what its label above says. */
export type TaskRef = Pick<Task, "id" | "title" | "state"> & {
  /** The task brought replies the person has not seen: its label says "Novas respostas". */
  unread: boolean;
};

const refOf = (task: Task): TaskRef => ({
  id: task.id,
  title: task.title,
  state: task.state,
  unread: task.unreadReplies > 0,
});

/**
 * The task a bot message comes from, by the structure the server declares and never by its text:
 * the message of the turn that delivered the task's result (`closingRunId`), or one of the run that
 * opened the task, written after it opened (the bot's words about it: the newest task of that run).
 */
export function taskOfMessage(
  message: Pick<LocalMessage, "runId" | "createdAt" | "authorKind">,
  tasks: readonly Task[],
): TaskRef | undefined {
  if (message.authorKind !== "bot" || message.runId === null) return undefined;
  const closing = tasks.find((t) => t.closingRunId === message.runId);
  if (closing !== undefined) return refOf(closing);
  const opened = tasks
    .filter((t) => t.fromRunId === message.runId && t.createdAt <= message.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return opened === undefined ? undefined : refOf(opened);
}

/**
 * Every task the bot's message opened (the run that opened them is the message's, they existed when
 * it was written), oldest first: a message may open several at once. `[]` for any other message.
 */
export function tasksOfMessage(
  message: Pick<LocalMessage, "runId" | "createdAt" | "authorKind">,
  tasks: readonly Task[],
): TaskRef[] {
  if (message.authorKind !== "bot" || message.runId === null) return [];
  if (tasks.some((t) => t.closingRunId === message.runId)) return [];
  return tasks
    .filter((t) => t.fromRunId === message.runId && t.createdAt <= message.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(refOf);
}

export type TimelineItem =
  | { kind: "separator"; key: string; text: string }
  | { kind: "user"; key: string; text: string; state: UserMessageState }
  | {
      kind: "bot";
      key: string;
      text: string;
      /** The task this message comes from: the bubble gets its label above (KOD-68). */
      task?: TaskRef;
      /** The message opened several tasks: all of them (one link each, a label with the count). */
      tasks?: readonly TaskRef[];
      /** The answer is still being written (KOD-34): the live text, not yet a recorded message. */
      live?: true;
      /** Present when the message is a question: what was asked, and whether it is still waiting. */
      ask?: {
        questions: readonly Question[];
        /** The text of the user's reply, once there is one (it can be a message still being sent). */
        answer: string | undefined;
        /** The run still waits for the reply. */
        open: boolean;
        /** The user closed the card with its X (`message.question.dismissed`): locked, "Não respondido". */
        dismissed: boolean;
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
  | { kind: "approval"; key: string; approval: Approval; task?: TaskRef }
  /** What the bot handed over to connect something: the card with the one button that fits. */
  | { kind: "connect"; key: string; card: ConnectCardItem }
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

/** `{ seq }` when there is one: the optional field is left out, never `undefined`. */
const seqOf = (seq: number | undefined): { seq?: number } => (seq === undefined ? {} : { seq });

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Hoje", "Ontem" or the date: the name of a day. */
export function dayName(date: Date, now: Date): string {
  const diff = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  return diff === 0
    ? "Hoje"
    : diff === 1
      ? "Ontem"
      : date.toLocaleDateString("pt-BR", {
          day: "numeric",
          month: "short",
          ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        });
}

/** The name of the day plus the time: the line that opens a day. */
export function dayLabel(date: Date, now: Date): string {
  return `${dayName(date, now)} · ${timeOf(date)}`;
}

/** How long ago, short: "agora", "3 min", the time of day today, else the day ("ontem", "12 de nov"). */
export function agoText(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  return dayStart(date) === dayStart(now) ? timeOf(date) : dayName(date, now).toLowerCase();
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
    connectCards?: readonly ConnectCardItem[];
    /**
     * The place of each call in its run's log (`callSeqsOf`), to order an approval against the
     * words of its turn. The cards of connect and secret carry their own `seq`.
     */
    callSeqs?: Readonly<Record<string, number>>;
    /**
     * The answers being typed (`liveView`): bubbles placed where the recorded text will be, and the
     * key a recorded message keeps from the bubble it replaced (the same element stays).
     */
    live?: LiveView;
    /** The tasks asked in this chat: labels above what comes from them, and where their cards go. */
    tasks?: readonly Task[];
  } = {},
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tasks = extras.tasks ?? [];
  // The run of a task never has a message of its own in this chat: its cards are placed by time.
  const opened = new Set<string>(tasks.map((t) => t.runId));
  // The cards that need (or needed) you, in the order they were asked.
  type Placed = { at: string; runId: string; seq?: number } & (
    | { kind: "approval"; approval: Approval }
    | { kind: "secret"; request: SecretRequestItem }
    | { kind: "connect"; card: ConnectCardItem }
  );
  const waiting: Placed[] = [
    // An approved proposal of a connector is drawn as its card, not as a row of the tool.
    ...(extras.approvals ?? [])
      .filter((a) => !isApprovedProposal(a))
      .map(
        (approval): Placed => ({
          kind: "approval",
          at: approval.createdAt,
          runId: approval.runId,
          ...seqOf(extras.callSeqs?.[callSeqKey(approval.runId, approval.callId)]),
          approval,
        }),
      ),
    ...(extras.connectCards ?? []).map(
      (card): Placed => ({
        kind: "connect",
        at: card.at,
        runId: card.runId,
        ...seqOf(card.seq),
        card,
      }),
    ),
    ...(extras.secrets ?? []).map(
      (request): Placed => ({
        kind: "secret",
        at: request.startedAt,
        runId: request.runId,
        seq: request.seq,
        request,
      }),
    ),
  ].sort(
    // The cards of one run are in the order of its log; any other pair, in the order of the time.
    (a, b) =>
      a.runId === b.runId && a.seq !== undefined && b.seq !== undefined
        ? a.seq - b.seq
        : a.at.localeCompare(b.at),
  );
  let previous: Date | undefined;

  // The words the bot writes in a turn that also calls tools are messages of their own (KOD-64,
  // `docs/pesquisas/kod-64-...`): written with the turn, before the call that becomes the card.
  // The chat is the messages and the cards in the order of the log: a card goes before the words
  // that came AFTER it in its run (by `seq`: the card's call against `message.eventSeq`), never
  // by time, which two writes can share. Anything the run wrote without a `seq` of its own (the
  // question, the end) comes after every card of that run; the rest is placed by time.
  const cardComesBefore = (card: Placed, message: LocalMessage): boolean => {
    if (message.runId === card.runId && message.authorKind !== "user") {
      if (message.eventSeq !== undefined && card.seq !== undefined)
        return card.seq < message.eventSeq;
      if (message.eventSeq === undefined) return true;
    }
    return card.at <= message.createdAt;
  };

  // The cards due before `message` (all that remains, with no message).
  const flush = (message?: LocalMessage) => {
    while (waiting.length > 0) {
      const next = waiting[0] as Placed;
      const ready = opened.has(next.runId) || message === undefined;
      if (!ready || (message !== undefined && !cardComesBefore(next, message))) break;
      waiting.shift();
      pushCard(next);
    }
  };
  const pushCard = (next: Placed) => {
    if (next.kind === "approval") {
      const task = tasks.find((t) => t.runId === next.approval.runId);
      items.push({
        kind: "approval",
        key: `approval-${next.approval.id}`,
        approval: next.approval,
        ...(task === undefined ? {} : { task: refOf(task) }),
      });
    } else if (next.kind === "connect")
      items.push({ kind: "connect", key: `connect-${next.card.callId}`, card: next.card });
    else
      items.push({
        kind: "secret",
        key: `secret-${next.request.callId}`,
        request: next.request,
      });
  };

  messages.forEach((message, index) => {
    const at = new Date(message.createdAt);
    // The user answered a question card by clicking it (`message.questionRef`, declared by the
    // server, KOD-15): the answer shows only on that card, never as a bubble of its own. It still
    // opens its run for the cards that wait on it; it draws nothing, not even a separator.
    if (message.authorKind === "user" && message.questionRef !== undefined) {
      if (message.local === undefined) {
        flush(message);
        if (message.runId !== null) opened.add(message.runId);
      }
      return;
    }
    if (message.local === undefined) {
      flush(message);
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
      // A message that took the place of a typed bubble keeps the bubble's key: the same element.
      const task = taskOfMessage(message, tasks);
      const opened = tasksOfMessage(message, tasks);
      items.push({
        kind: "bot",
        key: extras.live?.keyOf[message.id] ?? message.id,
        text: message.text,
        ...(task === undefined ? {} : { task }),
        ...(opened.length > 1 ? { tasks: opened } : {}),
      });
    } else {
      // The reply is the next message of the user, even one still being sent: the card answers at
      // once. An answer clicked on ANOTHER card (`questionRef`) is that card's, never this one's.
      const reply = messages
        .slice(index + 1)
        .find(
          (m) =>
            m.authorKind === "user" &&
            (m.questionRef === undefined || m.questionRef.id === message.id),
        );
      items.push({
        kind: "bot",
        key: message.id,
        text: message.text,
        ask: {
          questions: message.question.questions,
          answer: reply?.text,
          open:
            reply === undefined &&
            run?.status === "waiting_user" &&
            message.question.dismissed !== true,
          dismissed: message.question.dismissed === true,
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
  // The answers being typed come after everything recorded, but before the cards that the same
  // run asked LATER (by `seq`): where the recorded words will be when they replace the bubble.
  for (const bubble of extras.live?.typing ?? []) {
    while (waiting.length > 0) {
      const next = waiting[0] as Placed;
      const later = next.runId === bubble.runId && next.seq !== undefined && next.seq > bubble.call;
      if (later || !opened.has(next.runId)) break;
      waiting.shift();
      pushCard(next);
    }
    const closing = tasks.find((t) => t.closingRunId === bubble.runId);
    items.push({
      kind: "bot",
      key: bubble.key,
      text: bubble.text,
      live: true,
      ...(closing === undefined ? {} : { task: refOf(closing) }),
    });
  }
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
    // A bubble with the label of a task above it starts a group of its own (KOD-68).
    if (who === null || who !== sender || (item.kind === "bot" && item.task !== undefined)) close();
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
