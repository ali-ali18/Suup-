import {
  type Change,
  changeChannel,
  changeLogBounds,
  type Db,
  getApproval,
  getBotSummary,
  getConversation,
  getMemory,
  getMessage,
  getRun,
  getTask,
  latestMemoryReviews,
  listActiveConversationRuns,
  listChanges,
  listRunEvents,
} from "@suup/db";
import {
  toApprovalDto,
  toBotDto,
  toConversationDto,
  toMemoryDto,
  toMessageDto,
  toRunDto,
  toRunEventDto,
  type toTaskDto,
} from "../mappers.js";
import { taskDtoOf } from "../task-dto.js";
import type { ChangeSource, Notifier, Resolved, WireEvent } from "./hub.js";

/** Kinds whose events are snapshots of the row: several changes in a batch need only the last. */
const COALESCE = new Set<Change["kind"]>(["run", "conversation", "bot", "approval", "task"]);

/**
 * The hub's view of the database: the change log as the source, and the rows it points at read
 * into stream events. An event always carries the CURRENT state of its row (a `run.updated` after
 * three quick updates shows the last state), except `run.event`, which is one specific event of
 * the append-only log.
 */
export function createDbSource(
  db: Db,
  /** Scrubs known secret values out of what is about to be sent (see `Runtime.redactJson`). */
  redact: <T>(value: T) => Promise<T> = async (value) => value,
): ChangeSource<Change> {
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
        const events = await redact(await eventsOf(db, change, wantRun));
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
        change.op === "archived" ||
        change.op === "restored" ||
        change.op === "updated" ||
        change.op === "pending"
          ? change.op
          : "created";
      // A pending memory goes out with what the reviewer said about it, so the card can show why.
      const review =
        memory.status === "pending"
          ? ((await latestMemoryReviews(db, [memory.id])).get(memory.id) ?? null)
          : undefined;
      return [
        {
          type: "memory.changed",
          key: `memory:${memory.id}`,
          version: memory.updatedAt.getTime(),
          data: { change: kind, memory: toMemoryDto(memory, review) },
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
    case "approval": {
      const approval = await getApproval(db, change.ref);
      return approval === null
        ? []
        : [
            {
              type: "approval.changed",
              key: `approval:${approval.id}`,
              version: (approval.decidedAt ?? approval.createdAt).getTime(),
              data: {
                change: change.op === "created" ? "created" : "updated",
                approval: toApprovalDto(approval),
              },
            },
          ];
    }
    case "task": {
      const task = await getTask(db, change.ref);
      const run = task === null ? null : await getRun(db, task.runId);
      if (task === null || run === null) return [];
      return [
        taskEvent(
          task,
          run,
          change.op === "created" ? "created" : "updated",
          await taskDtoOf(db, task, run),
        ),
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

function taskEvent(
  task: Parameters<typeof toTaskDto>[0],
  run: Parameters<typeof toTaskDto>[1],
  change: "created" | "updated",
  dto: ReturnType<typeof toTaskDto>,
): WireEvent {
  return {
    type: "task.changed",
    key: `task:${task.id}`,
    version: run.updatedAt.getTime(),
    data: { change, task: dto },
  };
}
