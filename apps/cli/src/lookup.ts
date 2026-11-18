import { parseRunEvent } from "@suup/core";
import { type Bot, type Db, getRun, listBots, listRunEvents, type Run } from "@suup/db";
import { CommandError } from "./errors.js";
import type { RawEvent } from "./render.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PREFIX = /^[0-9a-f][0-9a-f-]{3,35}$/i;

/** A bot by full id, id prefix or exact name. Archived bots are found too. */
export async function findBot(db: Db, ref: string): Promise<Bot> {
  const all = await listBots(db, { includeArchived: true });
  const byId = all.filter((b) => b.id === ref.toLowerCase());
  const byPrefix = HEX_PREFIX.test(ref)
    ? all.filter((b) => b.id.startsWith(ref.toLowerCase()))
    : [];
  const byName = all.filter((b) => b.name === ref);
  const found = byId.length > 0 ? byId : byName.length > 0 ? byName : byPrefix;
  if (found.length === 0) {
    throw new CommandError(
      `Bot não encontrado: ${JSON.stringify(ref)}. Veja os existentes com: suup bot list`,
    );
  }
  if (found.length > 1) {
    throw new CommandError(
      `${JSON.stringify(ref)} corresponde a mais de um bot (${found.map((b) => `${b.name} ${b.id.slice(0, 8)}`).join(", ")}). Use o id.`,
    );
  }
  return found[0] as Bot;
}

/** A run by full id or unique id prefix. */
export async function findRun(db: Db, ref: string): Promise<Run> {
  if (UUID.test(ref)) {
    const run = await getRun(db, ref.toLowerCase());
    if (run === null)
      throw new CommandError(`Execução não encontrada: ${ref}. Veja as recentes com: suup runs`);
    return run;
  }
  if (!HEX_PREFIX.test(ref)) {
    throw new CommandError(
      `${JSON.stringify(ref)} não parece um id de execução (use o id completo ou o início dele, com pelo menos 4 caracteres).`,
    );
  }
  const rows = await db.sql<{ id: string }[]>`
    select id from runs where id::text like ${`${ref.toLowerCase()}%`} order by created_at desc limit 5`;
  if (rows.length === 0)
    throw new CommandError(`Execução não encontrada: ${ref}. Veja as recentes com: suup runs`);
  if (rows.length > 1) {
    throw new CommandError(
      `${JSON.stringify(ref)} corresponde a mais de uma execução (${rows.map((r) => r.id.slice(0, 12)).join(", ")}). Use mais caracteres do id.`,
    );
  }
  const run = await getRun(db, (rows[0] as { id: string }).id);
  if (run === null) throw new CommandError(`Execução não encontrada: ${ref}.`);
  return run;
}

/** Events of a run after `afterSeq`, raw (not validated against the schema). */
export async function readEvents(db: Db, runId: string, afterSeq = 0): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await listRunEvents(db, runId, { afterSeq: cursor, limit: 500 });
    for (const row of page) {
      out.push({ seq: row.seq, type: row.type, payload: row.payload, createdAt: row.createdAt });
    }
    const last = page[page.length - 1];
    if (page.length < 500 || last === undefined) return out;
    cursor = last.seq;
  }
}

/** The events as core's typed `StoredEvent`s (what `replayRun` takes). Throws if one is invalid. */
export function toRecorded(events: readonly RawEvent[]) {
  return events.map((e) => ({
    ...parseRunEvent(e.type, e.payload),
    seq: e.seq,
    createdAt: e.createdAt,
  }));
}
