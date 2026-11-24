import { z } from "zod";
import { createBot } from "./bots.js";
import { type Db, withTransaction } from "./client.js";
import { getMessage, type Message, type TeamProposal } from "./messages.js";
import type { Bot } from "./types.js";

/** The message has no team card, or the user already decided it. */
export class TeamProposalError extends Error {
  constructor(
    readonly code: "not_found" | "decided" | "invalid_pick",
    message: string,
  ) {
    super(message);
    this.name = "TeamProposalError";
  }
}

/** What each created bot gets besides what the proposal says (the same as the "Criar novo Bot" form). */
export interface TeamBotDefaults {
  modelProvider: string;
  modelId: string;
  allowedTools: string[];
}

export interface TeamPick {
  /** Which proposal of the card (its position). */
  index: number;
  /** The mascot and colour the card showed for it, so the bot is born looking the same. */
  avatar?: string;
  color?: string;
}

/**
 * The user's decision on a team card, atomically: under the lock of the message row, a card that is
 * still `pending` either becomes `dismissed` or creates one bot per ticked proposal (the same
 * `createBot` that `POST /v1/bots` uses) and becomes `created`. A card already decided is never
 * decided again (`TeamProposalError("decided")`), so a double click or two windows cannot make a
 * bot twice. Nothing else in the system creates bots from a proposal.
 */
export async function decideTeamProposal(
  db: Db,
  messageId: string,
  decision: { kind: "dismiss" } | { kind: "create"; picks: readonly TeamPick[] },
  defaults: TeamBotDefaults,
): Promise<{ message: Message; created: Bot[] }> {
  const id = z.uuid().parse(messageId);
  return withTransaction(db, async (tx) => {
    const [row] = await tx.sql<{ team: TeamProposal | null }[]>`
      select team from messages where id = ${id} for update`;
    const team = row?.team;
    if (team === null || team === undefined) {
      throw new TeamProposalError("not_found", "Esta mensagem não tem uma proposta de equipe.");
    }
    if (team.status !== "pending") {
      throw new TeamProposalError("decided", "Esta proposta de equipe já foi decidida.");
    }
    const created: Bot[] = [];
    let next: TeamProposal;
    if (decision.kind === "dismiss") {
      next = { ...team, status: "dismissed" };
    } else {
      const indexes = decision.picks.map((p) => p.index);
      if (
        indexes.length === 0 ||
        new Set(indexes).size !== indexes.length ||
        indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= team.items.length)
      ) {
        throw new TeamProposalError(
          "invalid_pick",
          "Escolha pelo menos um bot da proposta, sem repetir.",
        );
      }
      for (const pick of [...decision.picks].sort((a, b) => a.index - b.index)) {
        const item = team.items[pick.index];
        if (item === undefined) continue;
        created.push(
          await createBot(tx, {
            name: item.name,
            description: item.description,
            personality: item.personality,
            modelProvider: defaults.modelProvider,
            modelId: defaults.modelId,
            allowedTools: defaults.allowedTools,
            ...(pick.avatar === undefined ? {} : { avatar: pick.avatar }),
            ...(pick.color === undefined ? {} : { color: pick.color }),
          }),
        );
      }
      next = {
        ...team,
        status: "created",
        created: created.map((bot, n) => ({
          index: [...decision.picks].sort((a, b) => a.index - b.index)[n]?.index ?? 0,
          botId: bot.id,
        })),
      };
    }
    await tx.sql`update messages set team = ${tx.sql.json(next)} where id = ${id}`;
    const message = await getMessage(tx, id);
    if (message === null) throw new TeamProposalError("not_found", "Mensagem não encontrada.");
    return { message, created };
  });
}
