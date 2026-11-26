import { type BotRow, mapBot } from "./bots.js";
import type { Db } from "./client.js";
import type { Bot, RunStatus } from "./types.js";

/** The most recent run of a bot, reduced to what a list screen shows. */
export interface BotLatestRun {
  id: string;
  status: RunStatus;
  /** The run is paused by the user (see `Run.pausedAt`). */
  paused: boolean;
  objective: string;
  createdAt: Date;
}

/** A bot as the list screen shows it. */
export interface BotSummary {
  bot: Bot;
  /** The bot's most recent run of any origin, or `null` when it never ran. */
  latestRun: BotLatestRun | null;
  /** The bot's direct conversation, or `null` before the first message. */
  conversationId: string | null;
  /** Unread messages (from the bot or the system) in that conversation. */
  unreadCount: number;
}

interface SummaryRow extends BotRow {
  run_id: string | null;
  run_status: RunStatus | null;
  run_paused: boolean | null;
  run_objective: string | null;
  run_created_at: Date | null;
  conversation_id: string | null;
  unread: string;
}

function mapSummary(row: SummaryRow): BotSummary {
  return {
    bot: mapBot(row),
    latestRun:
      row.run_id === null
        ? null
        : {
            id: row.run_id,
            status: row.run_status as RunStatus,
            paused: row.run_paused === true,
            objective: row.run_objective ?? "",
            createdAt: row.run_created_at as Date,
          },
    conversationId: row.conversation_id,
    unreadCount: Number(row.unread),
  };
}

const SELECT = (db: Db) => db.sql`
  select b.*,
    r.id as run_id, r.status as run_status, (r.paused_at is not null) as run_paused,
    r.objective as run_objective, r.created_at as run_created_at,
    c.id as conversation_id,
    coalesce((
      select count(*) from messages m
      where m.conversation_id = c.id and m.author_kind <> 'user' and m.event_seq is null and m.seq > c.last_read_seq
    ), 0) as unread
  from bots b
  left join lateral (
    select * from runs where bot_id = b.id order by created_at desc, id limit 1
  ) r on true
  left join lateral (
    select c2.* from conversations c2
    join conversation_members cm on cm.conversation_id = c2.id
    where cm.bot_id = b.id and c2.kind = 'direct'
    limit 1
  ) c on true`;

/**
 * The bots with what the list screen needs: the status of the latest run and the unread count of
 * the direct conversation. Newest bot first (like `listBots`); archived ones only on request.
 */
export async function listBotSummaries(
  db: Db,
  opts: { includeArchived?: boolean } = {},
): Promise<BotSummary[]> {
  const rows = await db.sql<SummaryRow[]>`
    ${SELECT(db)}
    where ${opts.includeArchived ? db.sql`true` : db.sql`b.archived_at is null`}
    order by b.created_at desc, b.id`;
  return rows.map(mapSummary);
}

/** One bot with the same summary, or `null`. */
export async function getBotSummary(db: Db, botId: string): Promise<BotSummary | null> {
  const [row] = await db.sql<SummaryRow[]>`${SELECT(db)} where b.id = ${botId}`;
  return row === undefined ? null : mapSummary(row);
}
