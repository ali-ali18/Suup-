import { useEffect, useRef, useState } from "react";

// The text of an answer being written appears with a soft fade (KOD-34, owner 25/11/2026): what
// arrives in each frame fades in, what is already there stays still. No mark at the end, no
// letter-by-letter effect. The chunk that just arrived is wrapped in its own element; once its fade
// is over it goes back to plain text, so the number of elements stays small however long the text.

/** How long a chunk keeps its own element (a little more than the fade itself, `ui-live-in`). */
export const FADE_MS = 260;

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
    // The cut points inside this piece: where each chunk starts.
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

/** The sink for the text being written; `undefined` when it is not being written (no fade at all). */
export function useLiveFade(text: string, active: boolean): FadeSink | undefined {
  const mem = useRef({ chunks: [] as Chunk[], total: 0, text: "", next: 1 });
  const [tick, setTick] = useState(0);
  const now = Date.now();
  let sink: FadeSink | undefined;
  let chunks: Chunk[] = [];
  if (active) {
    const m = mem.current;
    chunks = m.chunks.filter((c) => now - c.at < FADE_MS);
    // New text: what lies past the end of the last drawing is the new chunk.
    if (text !== m.text) chunks.push({ id: m.next, start: m.total, at: now });
    sink = new FadeSink(chunks);
  }
  useEffect(() => {
    if (sink === undefined) return;
    const m = mem.current;
    m.chunks = chunks;
    m.total = sink.total;
    if (text !== m.text) m.next += 1;
    m.text = text;
    if (chunks.length === 0) return;
    // Later, draw again: the chunks whose fade is over go back to plain text.
    const timer = setTimeout(() => setTick(tick + 1), FADE_MS + 30);
    return () => clearTimeout(timer);
  });
  return sink;
}
