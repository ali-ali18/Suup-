// Where the live text of a run travels from the worker to the server (KOD-34). Nothing here is
// stored: it is a bell, not a log. A frame lost on the way costs only the typing effect, because the
// recorded message always arrives through the change log.
//
// The worker and the server share a process in the desktop app and in `suup server --with-worker`:
// there the frame goes straight to the server's subscriber. With `crossProcess` (the default, for a
// server and workers that may be separate processes) it also goes through a Postgres NOTIFY on a
// channel of its own, and the server LISTENs. A frame carries the id of the runtime that sent it, so
// a process that hears its own NOTIFY ignores it.
import { randomUUID } from "node:crypto";
import type { LiveFrame } from "@suup/core";
import type { Db } from "@suup/db";

/** A NOTIFY payload must stay under 8000 bytes (PostgreSQL); the margin is for the envelope. */
export const LIVE_NOTIFY_MAX_BYTES = 6_000;
/** Frames waiting to be sent through the database; the oldest are dropped past this. */
export const LIVE_QUEUE_MAX = 400;

export interface LiveChannel {
  /** Hands a frame over. Never throws and never waits: live text is best effort. */
  publish(frame: LiveFrame): void;
  /** Frames from this process and, when `listen` was called, from the others. */
  subscribe(listener: (frame: LiveFrame) => void): () => void;
  /** Starts hearing the other processes (only does something with `crossProcess`). */
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface Envelope {
  /** The runtime that sent it. */
  o: string;
  f: LiveFrame;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The frame in pieces that fit a NOTIFY: a long text is cut in two, with the offsets kept. */
export function splitFrame(frame: LiveFrame, origin: string): string[] {
  const payload = JSON.stringify({ o: origin, f: frame } satisfies Envelope);
  if (bytes(payload) <= LIVE_NOTIFY_MAX_BYTES || frame.type !== "live.text") return [payload];
  let cut = Math.floor(frame.text.length / 2);
  if (cut <= 0) return [];
  const code = frame.text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--; // never between the halves of a pair
  if (cut <= 0) return [];
  return [
    ...splitFrame({ ...frame, text: frame.text.slice(0, cut) }, origin),
    ...splitFrame({ ...frame, offset: frame.offset + cut, text: frame.text.slice(cut) }, origin),
  ];
}

export function createLiveChannel(options: {
  db: () => Db;
  crossProcess: boolean;
  /** Called when a send fails (the queue goes on). */
  onError?: (error: unknown) => void;
}): LiveChannel {
  const origin = randomUUID();
  const listeners = new Set<(frame: LiveFrame) => void>();
  const queue: string[] = [];
  let sending = false;
  let channelName: Promise<string> | undefined;
  let subscription: { unlisten(): Promise<unknown> } | undefined;
  let closed = false;

  const nameOf = (): Promise<string> => {
    channelName ??= (async () => {
      const [row] = await options.db().sql<{ schema: string }[]>`select current_schema() as schema`;
      return `suup_live_${row?.schema ?? "public"}`;
    })();
    return channelName;
  };

  const deliver = (frame: LiveFrame) => {
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch {
        // one broken listener must not stop the others
      }
    }
  };

  const drain = async () => {
    if (sending) return;
    sending = true;
    try {
      while (queue.length > 0 && !closed) {
        const payload = queue.shift() as string;
        try {
          const channel = await nameOf();
          // A statement of its own on the pool: it is delivered at once, never held by a
          // long transaction.
          await options.db().sql.notify(channel, payload);
        } catch (error) {
          options.onError?.(error);
        }
      }
    } finally {
      sending = false;
    }
  };

  return {
    publish(frame) {
      if (closed) return;
      deliver(frame);
      if (!options.crossProcess) return;
      for (const payload of splitFrame(frame, origin)) queue.push(payload);
      if (queue.length > LIVE_QUEUE_MAX) queue.splice(0, queue.length - LIVE_QUEUE_MAX);
      void drain();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listen() {
      if (!options.crossProcess || subscription !== undefined) return;
      const channel = await nameOf();
      subscription = await options.db().sql.listen(channel, (payload) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(payload) as Envelope;
        } catch {
          return;
        }
        if (envelope.o === origin || typeof envelope.f !== "object" || envelope.f === null) return;
        deliver(envelope.f);
      });
    },
    async close() {
      closed = true;
      queue.length = 0;
      const current = subscription;
      subscription = undefined;
      await current?.unlisten().catch(() => {});
    },
  };
}
