// Text shown while the model is still writing it (KOD-34). It is NEVER recorded: it does not become
// a message, does not enter the history and does not enter `run_events`. It leaves the worker as
// ephemeral frames, already scrubbed of every known secret, and the recorded text replaces it when
// the turn is saved. Nothing here is read back by the loop.
import type { ProviderEvent } from "../provider.js";
import { FINISH_TOOL_NAME } from "../provider.js";
import type { Redactor } from "../secrets.js";

/** The run origins whose answers the user reads in the chat: only those get parts and live text. */
export const CONVERSATION_ORIGINS: ReadonlySet<string> = new Set(["user", "reception"]);

/** What a run needs to be shown live: a conversation, an origin that answers, not an evaluation. */
export function liveAllowed(run: {
  conversationId: string | null | undefined;
  origin: string;
  isolated?: boolean | undefined;
}): boolean {
  return (
    run.conversationId !== null &&
    run.conversationId !== undefined &&
    CONVERSATION_ORIGINS.has(run.origin) &&
    run.isolated !== true
  );
}

/** How a live call ended. Anything but `recorded` means the text typed so far is thrown away. */
export const LIVE_OUTCOMES = ["recorded", "dropped", "aborted", "failed", "retry"] as const;
export type LiveOutcome = (typeof LIVE_OUTCOMES)[number];

/**
 * One frame. `call` is the `seq` of the call's `model_request` event (known before the answer) and
 * `block` the position, among the call's blocks that are shown, of the text; `offset` is where
 * `text` starts in the block's text (already scrubbed).
 */
export type LiveFrame =
  | {
      type: "live.text";
      runId: string;
      call: number;
      attempt: number;
      block: number;
      offset: number;
      text: string;
    }
  | {
      type: "live.end";
      runId: string;
      call: number;
      attempt: number;
      /** Only one block ended (dropped); without it, the whole call ended. */
      block?: number;
      outcome: LiveOutcome;
    };

/** Where a run's live frames go. Best effort: it must never throw or wait on anything slow. */
export interface LiveFeed {
  publish(frame: LiveFrame): void;
}

/** The most characters of one block shown live; the recorded text has all of it. */
export const LIVE_MAX_BLOCK_CHARS = 64_000;
/** Deltas are grouped for this long before a frame goes out. */
export const LIVE_BATCH_MS = 50;

export interface LiveTextOptions {
  runId: string;
  call: number;
  attempt: number;
  feed: LiveFeed;
  /** The vault's redactor. Without one nothing is known to hide. */
  redactor: Redactor | undefined;
  /** 0 sends every event at once (tests). Default `LIVE_BATCH_MS`. */
  batchMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Segment {
  block: number;
  raw: string;
  /** How much of the scrubbed text has gone out. */
  sent: number;
  /** The block is complete: its last characters are no longer held back. */
  closed: boolean;
  /** At least one character that is not whitespace arrived: only then does a bubble exist. */
  shown: boolean;
  kind: "text" | "summary";
}

/**
 * Turns the events of one model call into live frames. Rules:
 * - the text of a block is scrubbed as a whole (so a value cut between two deltas is found) and the
 *   last `longest needle - 1` characters are held back until the block closes, because a secret
 *   may be completed by the next delta;
 * - a text block that is only whitespace never shows (the recorded message needs text too);
 * - when the model starts the `finish` call, the text blocks of the turn are dropped (that turn
 *   posts no part: the summary is the end message) and the summary is typed in their place.
 */
export class LiveText {
  readonly #o: LiveTextOptions;
  readonly #segments: Segment[] = [];
  #open: Segment | undefined;
  #nextBlock = 0;
  #finishSeen = false;
  #summaryClosed = false;
  #timer: unknown;
  #ended = false;
  #longest = 0;
  /** Blocks that went out and were not dropped. */
  #shown = new Set<number>();

  constructor(options: LiveTextOptions) {
    this.#o = options;
  }

  /** Feed every provider event; the ones that are not about text are ignored or close a block. */
  onEvent(event: ProviderEvent): void {
    if (this.#ended) return;
    switch (event.type) {
      case "text_delta":
        if (this.#finishSeen) return; // that turn posts no part
        this.#append("text", event.text);
        break;
      case "summary_delta":
        if (!this.#finishSeen || this.#summaryClosed) return;
        this.#append("summary", event.text);
        break;
      case "finish_start":
        if (this.#finishSeen) return;
        this.#finishSeen = true;
        this.#close();
        for (const seg of this.#segments) {
          const sent = this.#shown.has(seg.block);
          seg.shown = false;
          if (sent) this.#drop(seg.block);
        }
        break;
      case "tool_call":
        this.#close();
        if (this.#finishSeen && event.name === FINISH_TOOL_NAME) this.#summaryClosed = true;
        break;
      case "provider_data":
        this.#close();
        break;
      default:
        break;
    }
    this.#schedule();
  }

  /** The model finished writing: every block is complete, so nothing is held back any more. */
  complete(): void {
    if (this.#ended) return;
    this.#close();
    this.#cancelTimer();
    this.#flush();
  }

  /** The call is over. `recorded`: the response was saved (flush what is held back first). */
  end(outcome: "recorded" | "aborted" | "failed" | "retry"): void {
    if (this.#ended) return;
    if (outcome === "recorded") {
      this.#close();
      this.#flush();
    }
    this.#ended = true;
    this.#cancelTimer();
    this.#send({
      type: "live.end",
      runId: this.#o.runId,
      call: this.#o.call,
      attempt: this.#o.attempt,
      outcome,
    });
  }

  #append(kind: "text" | "summary", text: string): void {
    if (text === "") return;
    let seg = this.#open;
    if (seg === undefined || seg.kind !== kind) {
      this.#close();
      seg = {
        block: this.#nextBlock++,
        raw: "",
        sent: 0,
        closed: false,
        shown: false,
        kind,
      };
      this.#segments.push(seg);
      this.#open = seg;
    }
    seg.raw += text;
    if (!seg.shown && seg.raw.trim() !== "") seg.shown = true;
  }

  #close(): void {
    if (this.#open !== undefined) this.#open.closed = true;
    this.#open = undefined;
  }

  #schedule(): void {
    const ms = this.#o.batchMs ?? LIVE_BATCH_MS;
    if (ms <= 0) {
      this.#flush();
      return;
    }
    if (this.#timer !== undefined) return;
    const set = this.#o.setTimer ?? ((fn, wait) => setTimeout(fn, wait));
    this.#timer = set(() => {
      this.#timer = undefined;
      this.#flush();
    }, ms);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    const clear =
      this.#o.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(this.#timer);
    this.#timer = undefined;
  }

  /** Sends what is safe: the scrubbed text minus the characters a later delta may still change. */
  #flush(): void {
    const redactor = this.#o.redactor;
    for (const seg of this.#segments) {
      if (!seg.shown) continue;
      if (seg.sent >= LIVE_MAX_BLOCK_CHARS) continue;
      // The vault can learn a value while the model writes (another run resolves a secret): the
      // hold-back follows the longest text known so far, never less than it was.
      this.#longest = Math.max(this.#longest, redactor?.longestNeedle() ?? 0);
      const scrubbed = redactor === undefined ? seg.raw : redactor.redact(seg.raw);
      let safe = seg.closed ? scrubbed.length : scrubbed.length - Math.max(this.#longest - 1, 0);
      safe = Math.min(safe, LIVE_MAX_BLOCK_CHARS);
      // Never cut a surrogate pair in two.
      if (safe > 0 && safe < scrubbed.length) {
        const code = scrubbed.charCodeAt(safe - 1);
        if (code >= 0xd800 && code <= 0xdbff) safe--;
      }
      if (safe <= seg.sent) continue;
      const text = scrubbed.slice(seg.sent, safe);
      const offset = seg.sent;
      seg.sent = safe;
      this.#shown.add(seg.block);
      this.#send({
        type: "live.text",
        runId: this.#o.runId,
        call: this.#o.call,
        attempt: this.#o.attempt,
        block: seg.block,
        offset,
        text,
      });
    }
  }

  #drop(block: number): void {
    this.#shown.delete(block);
    this.#send({
      type: "live.end",
      runId: this.#o.runId,
      call: this.#o.call,
      attempt: this.#o.attempt,
      block,
      outcome: "dropped",
    });
  }

  #send(frame: LiveFrame): void {
    try {
      this.#o.feed.publish(frame);
    } catch {
      // live text is best effort: it can never fail or slow the run
    }
  }
}
