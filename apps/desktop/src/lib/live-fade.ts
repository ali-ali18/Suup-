import { useEffect, useRef, useState } from "react";
import { readReducedMotion } from "./reduced-motion.js";

// The text of an answer being written appears letter by letter, progressively (KOD-34, owner
// 25/11/2026: "é só ir aparecendo as letras, sem prévias dela"). The text received is kept whole,
// but only a revealed prefix is drawn: what was not revealed yet does not exist on screen (not even
// transparent, and it takes no space). Each newly revealed piece comes in with a short, soft fade;
// once the fade is over it goes back to plain text, so the DOM stays small. No mark at the end.

/** How long a piece keeps its own element: the fade itself (`ui-live-in`, 130 ms) plus a margin. */
export const FADE_MS = 180;

/**
 * Comfortable reading speed when there is no backlog, in characters per second. A fast reader takes
 * in about 25 characters a second, a model streams 50 to 150, and ChatGPT-like reveals sit near
 * 80: slow enough to look written, fast enough not to hold the answer back.
 */
export const BASE_CPS = 80;

/**
 * The backlog (received, not yet shown) is cleared in about this many seconds: the speed is
 * `backlog / CATCHUP_S`, so a burst of 600 characters is shown at 2000 per second at first and the
 * reveal is never far behind the model. 0.3 s is perceived as "right away" (under the 0.4 s that
 * Doherty's threshold calls instantaneous) yet still a visible, smooth reveal.
 */
export const CATCHUP_S = 0.3;

/** The longest step of time counted in one frame (a hidden tab pauses the frames). */
const MAX_DT_MS = 100;

/** Characters per second to reveal, given how many are waiting. */
export function revealRate(backlog: number): number {
  return Math.max(BASE_CPS, backlog / CATCHUP_S);
}

interface Segmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
const segmenter: Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => Segmenter }).Segmenter(
        undefined,
        { granularity: "grapheme" },
      )
    : null;

/**
 * Where a reveal of at least `n` more characters from `from` ends: always at the end of a grapheme
 * (code points if the runtime has no segmenter), so a surrogate pair or a letter with its accent is
 * never cut in half. At least one grapheme when `n` >= 1 and there is text left.
 */
export function advanceReveal(text: string, from: number, n: number): number {
  if (n < 1 || from >= text.length) return from;
  const window = text.slice(from, from + n + 32);
  let used = 0;
  if (segmenter !== null) {
    for (const part of segmenter.segment(window)) {
      used += part.segment.length;
      if (used >= n) break;
    }
  } else {
    for (const point of window) {
      used += point.length;
      if (used >= n) break;
    }
  }
  return Math.min(text.length, from + used);
}

interface Chunk {
  id: number;
  /** Where it starts, in characters of the rendered text (markup is not counted). */
  start: number;
  at: number;
}

/** Passed to the markdown: it wraps each plain text it draws, in order, and counts the characters. */
export class FadeSink {
  total = 0;
  private n = 0;
  constructor(private readonly chunks: readonly Chunk[]) {}

  wrap(s: string): (string | { id: string; text: string })[] {
    const from = this.total;
    const to = from + s.length;
    this.total = to;
    const out: (string | { id: string; text: string })[] = [];
    let at = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i] as Chunk;
      const next = this.chunks[i + 1]?.start ?? Number.POSITIVE_INFINITY;
      const a = Math.max(chunk.start, from);
      const b = Math.min(next, to);
      if (b <= a) continue;
      if (a - from > at) out.push(s.slice(at, a - from));
      out.push({ id: `f${chunk.id}-${this.n++}`, text: s.slice(a - from, b - from) });
      at = b - from;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  }
}

export interface LiveReveal {
  /** The part of the text to draw: the revealed prefix. */
  shown: string;
  /** `undefined` when nothing fades (reduced motion, or not being written). */
  sink: FadeSink | undefined;
  /** Still being written: the text is being typed, or the recorded one is catching up. */
  live: boolean;
}

/**
 * The reveal of the text being written. `typing`: the live text is still arriving. When the recorded
 * text takes over (`typing` false) and the reveal has not caught up, it goes on to the end from where
 * it was, with no jump; only then `live` turns false and the final text is drawn in the same place.
 */
export function useLiveReveal(text: string, typing: boolean): LiveReveal {
  const mem = useRef({
    count: 0,
    carry: 0,
    chunks: [] as Chunk[],
    total: 0,
    drawn: 0,
    next: 1,
    seen: "",
    target: "",
    started: false,
    raf: 0,
    last: 0,
    advancedAt: 0,
  });
  const [, setTick] = useState(0);
  const m = mem.current;
  const now = performance.now();
  const reduced = readReducedMotion();
  m.target = text;
  if (typing) m.started = true;
  // What was revealed must still be the start of the text; if not, start over (typing) or finish.
  if (m.count > text.length || !text.startsWith(m.seen.slice(0, m.count))) {
    m.count = typing ? 0 : text.length;
    m.drawn = m.count;
    m.total = 0;
    m.chunks = [];
  }
  m.seen = text;
  if (reduced) m.count = text.length;
  // A bubble that only shows a recorded message (history) never reveals anything.
  const live =
    typing ||
    (!reduced && m.started && (m.count < text.length || now - m.advancedAt < FADE_MS + 40));
  const gradual = live && !reduced;
  let sink: FadeSink | undefined;
  let chunks: Chunk[] = [];
  if (gradual) {
    chunks = m.chunks.filter((c) => now - c.at < FADE_MS);
    if (m.count !== m.drawn) chunks.push({ id: m.next, start: m.total, at: now });
    sink = new FadeSink(chunks);
  }
  const count = gradual ? m.count : text.length;

  useEffect(() => {
    m.chunks = chunks;
    m.drawn = count;
    if (sink !== undefined) {
      m.total = sink.total;
      if (chunks.at(-1)?.id === m.next) m.next += 1;
    }
    if (!gradual || m.raf !== 0) return;
    m.last = performance.now();
    const frame = (t: number) => {
      m.raf = 0;
      const dt = Math.min(MAX_DT_MS, Math.max(0, t - m.last));
      m.last = t;
      const target = m.target;
      if (m.count < target.length) {
        m.carry += (revealRate(target.length - m.count) * dt) / 1000;
        const whole = Math.floor(m.carry);
        if (whole >= 1) {
          m.carry -= whole;
          m.count = advanceReveal(target, m.count, whole);
          m.advancedAt = t;
        }
      } else {
        m.carry = 0;
      }
      setTick((n) => n + 1);
      const young = t - m.advancedAt < FADE_MS + 40;
      // Idle (caught up, nothing fading): stop; the next text restarts it from the effect.
      if (m.count < target.length || young) m.raf = requestAnimationFrame(frame);
    };
    m.raf = requestAnimationFrame(frame);
  });
  useEffect(
    () => () => {
      cancelAnimationFrame(m.raf);
      m.raf = 0;
    },
    [m],
  );
  return { shown: text.slice(0, count), sink, live };
}
