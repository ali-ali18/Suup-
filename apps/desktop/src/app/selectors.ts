import type { Bot, Conversation, Message, Run } from "@suup/api";
import { arrangeBots, flatBots } from "../data/botlist.js";
import { deriveRunDisplay, type RunDisplay } from "../data/derive.js";
import { isTerminal } from "../data/reducers.js";
import type { DataState } from "../data/state.js";

/** Bots that can be talked to, in the order the sidebar shows them. */
export function sortedBots(bots: Record<string, Bot>): Bot[] {
  return flatBots(arrangeBots(bots));
}

/** The bot's most recent run: from the run table when we have it, else the summary on the bot. */
export function latestRunOf(
  bot: Bot,
  runs: Record<string, Run>,
): Pick<Run, "id" | "status" | "paused" | "startedAt" | "createdAt"> | null {
  let best: Run | undefined;
  for (const run of Object.values(runs)) {
    if (run.botId !== bot.id) continue;
    if (best === undefined || run.createdAt > best.createdAt) best = run;
  }
  const summary = bot.latestRun;
  if (best === undefined) {
    return summary === null
      ? null
      : {
          id: summary.id,
          status: summary.status,
          paused: summary.paused,
          startedAt: summary.status === "queued" ? null : summary.createdAt,
          createdAt: summary.createdAt,
        };
  }
  if (summary !== null && summary.createdAt > best.createdAt) {
    return {
      id: summary.id,
      status: summary.status,
      paused: summary.paused,
      startedAt: summary.status === "queued" ? null : summary.createdAt,
      createdAt: summary.createdAt,
    };
  }
  return best;
}

/** What the rail shows for a bot: the chip (only while something is going on) and the reaction. */
export function botDisplay(bot: Bot, runs: Record<string, Run>): RunDisplay {
  const run = latestRunOf(bot, runs);
  const display = deriveRunDisplay(run);
  // Finished runs are history, not a status: the list shows a seal only for what is going on.
  if (run !== null && isTerminal(run.status) && run.status !== "failed") {
    return { ...display, chip: null, label: "" };
  }
  return display;
}

export function unreadOf(bot: Bot, conversations: Record<string, Conversation>): number {
  const conversation = bot.conversationId === null ? undefined : conversations[bot.conversationId];
  return conversation?.unreadCount ?? bot.unreadCount;
}

/** Conversations that wait for an answer right now. */
export function pendingQuestions(state: Pick<DataState, "runs" | "bots">): Run[] {
  return Object.values(state.runs)
    .filter(
      (r) =>
        r.status === "waiting_user" &&
        r.conversationId !== null &&
        state.bots[r.botId] !== undefined,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The bot message that is the question asked in a run, if the conversation has it. */
export function questionMessageOf(
  messages: readonly Message[],
  runId: string,
): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m.runId === runId && m.authorKind === "bot" && m.question !== undefined) return m;
  }
  return undefined;
}
