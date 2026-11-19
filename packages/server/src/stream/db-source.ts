import {
  type Change,
  changeChannel,
  changeLogBounds,
  type Db,
  getBotSummary,
  getConversation,
  getMemory,
  getMessage,
  getRun,
  listActiveConversationRuns,
  listChanges,
  listRunEvents,
} from "@suup/db";
import {
  toBotDto,
  toConversationDto,
  toMemoryDto,
  toMessageDto,
  toRunDto,
  toRunEventDto,
} from "../mappers.js";
import type { ChangeSource, Notifier, Resolved, WireEvent } from "./hub.js";

/** Kinds whose events are snapshots of the row: several changes in a batch need only the last. */
const COALESCE = new Set<Change["kind"]>(["run", "conversation", "bot"]);

/**
 * The hub's view of the database: the change log as the source, and the rows it points at read
 * into stream events. An event always carries the CURRENT state of its row (a `run.updated` after
 * three quick updates shows the last state), except `run.event`, which is one specific event of
 * the append-only log.
 */
export function createDbSource(db: Db): ChangeSource<Change> {
  return {
    bounds: () => changeLogBounds(db),
    read: (afterId, limit) => listChanges(db, afterId, limit),
    async resolve(changes, wantRun) {
      // Only the last change of each coalescable row counts.
      const lastOf = new Map<string, number>();
      changes.forEach((c, i) => {
        if (COALESCE.has(c.kind)) lastOf.set(`${c.kind}:${c.ref}`, i);
      });
      const out: Resolved[] = [];
      for (const [index, change] of changes.entries()) {
        if (COALESCE.has(change.kind) && lastOf.get(`${change.kind}:${change.ref}`) !== index) {
          continue;
        }
        const events = await eventsOf(db, change, wantRun);
        if (events.length > 0) out.push({ id: change.id, events });
      }
      return out;
    },
  };
}

async function eventsOf(
  db: Db,
  change: Change,
  wantRun: (runId: string) => boolean,
): Promise<WireEvent[]> {
  switch (change.kind) {
    case "run_event": {
      if (change.seq === null || !wantRun(change.ref)) return [];
      const [event] = await listRunEvents(db, change.ref, {
        afterSeq: change.seq - 1,
        limit: 1,
        slim: true,
      });
      if (event === undefined || event.seq !== change.seq) return [];
      return [
        {
          type: "run.event",
          runId: change.ref,
          data: { runId: change.ref, event: toRunEventDto(event) },
        },
      ];
    }
    case "run": {
      const run = await getRun(db, change.ref);
      return run === null
        ? []
        : [
            {
              type: "run.updated",
              key: `run:${run.id}`,
              version: run.updatedAt.getTime(),
              data: { run: toRunDto(run) },
            },
          ];
    }
    case "message": {
      const message = await getMessage(db, change.ref);
      if (message === null) return [];
      return [
        {
          type: change.op === "created" ? "message.created" : "message.updated",
          data: { message: toMessageDto(message) },
        },
      ];
    }
    case "memory": {
      const memory = await getMemory(db, change.ref);
      if (memory === null) return [];
      const kind =
        change.op === "archived" || change.op === "restored" || change.op === "updated"
          ? change.op
          : "created";
      return [
        {
          type: "memory.changed",
          key: `memory:${memory.id}`,
          version: memory.updatedAt.getTime(),
          data: { change: kind, memory: toMemoryDto(memory) },
        },
      ];
    }
    case "conversation": {
      const view = await getConversation(db, change.ref);
      if (view === null) return [];
      const active = (await listActiveConversationRuns(db, [view.id])).get(view.id) ?? null;
      return [
        {
          type: "conversation.updated",
          key: `conversation:${view.id}`,
          version: view.updatedAt.getTime(),
          data: { conversation: toConversationDto(view, active) },
        },
      ];
    }
    case "bot": {
      const summary = await getBotSummary(db, change.ref);
      return summary === null
        ? []
        : [
            {
              type: "bot.updated",
              key: `bot:${summary.bot.id}`,
              version: summary.bot.updatedAt.getTime(),
              data: { bot: toBotDto(summary) },
            },
          ];
    }
  }
}

/**
 * `LISTEN` on the database's change channel (a connection of its own, which `postgres` reopens and
 * re-listens by itself after a drop). The notification payload is only the id of the change: the
 * hub reads the log, so a lost notification costs at most one poll interval.
 */
export function createPgNotifier(db: Db): Notifier {
  let subscription: { unlisten(): Promise<unknown> } | undefined;
  return {
    async start(wake) {
      const channel = await changeChannel(db);
      subscription = await db.sql.listen(
        channel,
        () => wake(),
        // On the first listen and after every reconnect: whatever was notified in between is
        // in the log.
        () => wake(),
      );
    },
    async stop() {
      const current = subscription;
      subscription = undefined;
      await current?.unlisten();
    },
  };
}
