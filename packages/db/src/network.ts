// Owns the network allowlist rows (tables `network_hosts` and `network_events`, migration 0015).
// The host names are validated by the caller (`parseAllowlistHost` of core); this module keeps
// them and answers what is allowed for a bot right now.
import { z } from "zod";
import type { Db } from "./client.js";

export interface NetworkHostRow {
  id: string;
  botId: string;
  host: string;
  /** `null`: allowed for the bot; otherwise only while that run is not finished. */
  runId: string | null;
  createdBy: "user" | "approval";
  createdAt: Date;
}

interface HostRow {
  id: string;
  bot_id: string;
  host: string;
  run_id: string | null;
  created_by: "user" | "approval";
  created_at: Date;
}

const map = (row: HostRow): NetworkHostRow => ({
  id: row.id,
  botId: row.bot_id,
  host: row.host,
  runId: row.run_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

/** Allows a host for the bot, until removed. `false`: it already was. */
export async function addBotHost(db: Db, botId: string, host: string): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    insert into network_hosts (bot_id, host) values (${z.uuid().parse(botId)}, ${host})
    on conflict (bot_id, host) where run_id is null do nothing returning id`;
  return rows.length > 0;
}

/** Allows a host for ONE run (what an approved card does). `false`: it already was. */
export async function grantRunHost(
  db: Db,
  botId: string,
  runId: string,
  host: string,
): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    insert into network_hosts (bot_id, host, run_id, created_by)
    values (${z.uuid().parse(botId)}, ${host}, ${z.uuid().parse(runId)}, 'approval')
    on conflict (run_id, host) where run_id is not null do nothing returning id`;
  return rows.length > 0;
}

/** Removes the bot's own entry for the host (the run grants stay until their run ends). */
export async function removeBotHost(db: Db, botId: string, host: string): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    delete from network_hosts where bot_id = ${z.uuid().parse(botId)} and host = ${host}
      and run_id is null returning id`;
  return rows.length > 0;
}

/** The bot's own entries (not the run grants), oldest first. */
export async function listBotHosts(db: Db, botId: string): Promise<NetworkHostRow[]> {
  const rows = await db.sql<HostRow[]>`
    select * from network_hosts where bot_id = ${z.uuid().parse(botId)} and run_id is null
    order by created_at, host`;
  return rows.map(map);
}

/**
 * What is allowed for the bot right now: its own entries plus the grants of runs that are not
 * finished (queued, running, waiting for an approval or for the user).
 */
export async function activeHostsForBot(db: Db, botId: string): Promise<string[]> {
  const rows = await db.sql<{ host: string }[]>`
    select distinct h.host from network_hosts h
    left join runs r on r.id = h.run_id
    where h.bot_id = ${z.uuid().parse(botId)}
      and (h.run_id is null or r.status in ('queued', 'running', 'waiting_approval', 'waiting_user', 'waiting_timer'))`;
  return rows.map((r) => r.host);
}

export interface NetworkEventInput {
  subjectKind: "bot" | "connector" | "harness";
  subjectId: string;
  host: string;
  port: number;
  reason: string;
  message: string;
}

export interface NetworkEventRow extends NetworkEventInput {
  id: number;
  createdAt: Date;
}

export async function recordNetworkEvent(db: Db, input: NetworkEventInput): Promise<void> {
  await db.sql`
    insert into network_events (subject_kind, subject_id, host, port, reason, message)
    values (${input.subjectKind}, ${input.subjectId.slice(0, 100)}, ${input.host.slice(0, 300)},
            ${input.port}, ${input.reason.slice(0, 50)}, ${input.message.slice(0, 1000)})`;
}

/** Newest first. */
export async function listNetworkEvents(
  db: Db,
  subject: { kind: "bot" | "connector" | "harness"; id: string },
  limit = 50,
): Promise<NetworkEventRow[]> {
  const rows = await db.sql<
    {
      id: string;
      subject_kind: NetworkEventInput["subjectKind"];
      subject_id: string;
      host: string;
      port: number;
      reason: string;
      message: string;
      created_at: Date;
    }[]
  >`select * from network_events where subject_kind = ${subject.kind} and subject_id = ${subject.id}
    order by id desc limit ${Math.min(Math.max(limit, 1), 500)}`;
  return rows.map((r) => ({
    id: Number(r.id),
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    host: r.host,
    port: r.port,
    reason: r.reason,
    message: r.message,
    createdAt: r.created_at,
  }));
}
