// Relógio compartilhado dos avatares pixel: UM laço de rAF para todos. Só desenha o que está na
// tela, pausa com a aba oculta e dorme sem nenhum avatar animado. O ambiente (rAF, visibilidade)
// é injetado, como no `createTicker` das formas: o núcleo não toca em `window`.
import type { TickerEnv } from "../runtime/ticker.js";

/** Intervalo mínimo entre quadros (~30 por segundo): o movimento é em degraus de poucos pixels. */
export const PIXEL_FRAME_MS = 33;

export type PixelClockEntry = {
  /** Desenha o que mudou em `nowMs` (o relógio do rAF). Deve ser barato quando nada mudou. */
  paint(nowMs: number): void;
  /** O que a tela observa para saber se o avatar está visível. */
  element?: unknown;
};

export type PixelClockHandle = { unregister(): void };

type Entry = PixelClockEntry & { visible: boolean; stop: (() => void) | null };

export type PixelClock = ReturnType<typeof createPixelClock>;

export function createPixelClock(env: TickerEnv) {
  const entries = new Set<Entry>();
  let rafId: number | null = null;
  let last = Number.NEGATIVE_INFINITY;
  let offVisibility: (() => void) | null = null;

  const anyVisible = () => {
    for (const entry of entries) if (entry.visible) return true;
    return false;
  };

  function ensureRunning() {
    if (rafId === null && !env.isHidden() && anyVisible()) rafId = env.raf(tick);
  }

  function tick(ts: number) {
    rafId = null;
    if (env.isHidden()) return;
    if (ts - last >= PIXEL_FRAME_MS) {
      last = ts;
      for (const entry of entries) if (entry.visible) entry.paint(ts);
    }
    ensureRunning();
  }

  function stopLoop() {
    if (rafId !== null) env.caf(rafId);
    rafId = null;
  }

  return {
    register(input: PixelClockEntry): PixelClockHandle {
      const entry: Entry = { ...input, visible: true, stop: null };
      entries.add(entry);
      offVisibility ??= env.onVisibilityChange(() => {
        if (env.isHidden()) stopLoop();
        else ensureRunning();
      });
      if (input.element) {
        entry.stop = env.observeVisible(input.element, (visible) => {
          entry.visible = visible;
          if (visible) ensureRunning();
        });
      }
      // O primeiro quadro sai já, sem esperar o rAF.
      entry.paint(env.now());
      ensureRunning();
      return {
        unregister() {
          entry.stop?.();
          entries.delete(entry);
          if (entries.size === 0) {
            stopLoop();
            offVisibility?.();
            offVisibility = null;
          }
        },
      };
    },
    /** Diagnóstico e testes. */
    stats() {
      return { entries: entries.size, looping: rafId !== null };
    },
  };
}
