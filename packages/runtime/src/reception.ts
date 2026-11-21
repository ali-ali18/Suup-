// The welcome of a bot (docs/RECEPCAO.md): started once, when the user first opens its chat, by a
// run the server opens itself; and the one tool the main bot has in it, `propose_team`.
import { defineTool } from "@suup/core";
import {
  appendMessageOnce,
  ConversationRuleError,
  getBot,
  getRun,
  type Run,
  resetReception,
  startReception,
} from "@suup/db";
import { z } from "zod";
import { type BotDraft, draftBot } from "./conversations.js";
import { RuntimeError } from "./errors.js";
import type { Runtime } from "./runtime.js";

/** What a welcome run is for. The model reads "First conversation" in its instructions for the how. */
export function receptionObjective(redo: boolean): string {
  return redo
    ? 'The user asked to redo your welcome. Do your first-conversation welcome again (see "First conversation" in your instructions). What you already know about them may have changed: confirm it instead of assuming it, and keep your memory correct (forget what is out of date).'
    : 'The user just opened your chat for the first time. Do your first-conversation welcome (see "First conversation" in your instructions).';
}

export interface ReceptionStart {
  conversationId: string;
  /** This call started it; the run is queued for a worker. */
  started: boolean;
  run: Run | null;
}

/**
 * Starts the welcome of the bot, if it is due: its conversation is empty and the welcome never ran
 * (or the user asked to redo it). Safe to call on every open of the chat, from any number of
 * windows: the database starts it at most once (see `startReception`). Throws `RuntimeError` for an
 * unknown or archived bot, or one whose model the configuration lacks.
 */
export async function startBotReception(runtime: Runtime, botId: string): Promise<ReceptionStart> {
  const bot = await getBot(runtime.db, botId);
  if (bot === null) throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
  if (bot.archivedAt !== null) {
    throw new RuntimeError("bot_archived", `O bot "${bot.name}" (${bot.id}) está arquivado.`);
  }
  runtime.botConfig(bot); // refuses a bot whose model or provider the configuration lacks
  try {
    return await startReception(runtime.db, bot.id, receptionObjective);
  } catch (error) {
    if (error instanceof ConversationRuleError) {
      throw new RuntimeError("bot_archived", `O bot "${bot.name}" está arquivado.`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** "Refazer a recepção": the next open of the bot's chat starts the welcome again. */
export async function resetBotReception(runtime: Runtime, botId: string): Promise<void> {
  const bot = await getBot(runtime.db, botId);
  if (bot === null) throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
  if (!(await resetReception(runtime.db, bot.id))) {
    throw new RuntimeError(
      "conflict",
      `O bot "${bot.name}" está numa conversa em andamento: termine ou cancele a execução antes de refazer a recepção.`,
    );
  }
}

export const PROPOSE_TEAM_TOOL = "propose_team";

const proposeTeamInput = z.object({
  bots: z
    .array(
      z.object({
        brief: z
          .string()
          .trim()
          .min(10)
          .max(800)
          .describe(
            "What this bot is for, as a short description in the user's language, built from what the user told you (their area, tasks, how they like to work). The app turns it into a name, a description and a personality.",
          ),
      }),
    )
    .min(2)
    .max(3),
});

/** The text of the chat message that carries the team card. */
export const TEAM_CARD_TEXT =
  "Montei uma proposta de equipe para você. Marque os bots que quiser criar.";

/**
 * `propose_team`, the one tool of the main bot's welcome that leads to bots: it turns each brief into
 * a draft (the same feature as `POST /v1/bots/draft`) and shows ONE card with all of them in the
 * chat. It creates nothing: the user ticks what they want and only then does the server create
 * those, through the normal path (`POST /v1/messages/{id}/team`). A card is written once per run.
 */
export function proposeTeamTool(runtime: Runtime) {
  return defineTool({
    name: PROPOSE_TEAM_TOOL,
    description:
      "Shows the user ONE card proposing 2 or 3 bots for their personal team, built from what they told you. Pass one brief per bot (what the bot is for). The user ticks which to create; you cannot create bots and nothing is created without their tick. Call it once, then continue with the next steps in plain text.",
    input: proposeTeamInput,
    // It only shows a proposal in the chat; creating anything is the user's own act.
    risk: "read",
    ownOutput: true,
    timeoutMs: 180_000,
    async execute({ bots }, ctx) {
      const run = await getRun(runtime.db, ctx.runId);
      const bot = await getBot(runtime.db, ctx.botId);
      if (run === null || bot === null || run.conversationId == null) {
        return { isError: true, content: "propose_team only works inside a chat conversation." };
      }
      let drafts: BotDraft[];
      try {
        drafts = await Promise.all(
          bots.map(({ brief }) => draftBot(runtime, { description: brief, modelId: bot.modelId })),
        );
      } catch (error) {
        return {
          isError: true,
          content: `Could not draft the bots (${error instanceof Error ? error.message : String(error)}). Skip the proposal and go on with the next steps.`,
        };
      }
      const { created } = await appendMessageOnce(runtime.db, {
        conversationId: run.conversationId,
        authorKind: "bot",
        authorBotId: bot.id,
        text: TEAM_CARD_TEXT,
        runId: run.id,
        dedupeKey: `run:${run.id}:team`,
        team: drafts,
      });
      return {
        content: created
          ? `The card with ${drafts.length} proposed bots (${drafts.map((d) => d.name).join(", ")}) is now in the chat. The user decides which to create. Do not create anything; continue with the next steps in plain text.`
          : "A team card was already shown in this conversation. Continue with the next steps in plain text.",
      };
    },
  });
}
