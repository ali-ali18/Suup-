import { BOT_PALETTE, type BotColor } from "@suup/api";
import {
  bobPixels,
  createPixelCharacter,
  createPixelPlayer,
  drawPixelFrame,
  drawPixelImage,
  layoutPixels,
  PIXEL_GRID,
  type PixelCharacterId,
  type PixelClockHandle,
  type PixelLayout,
  type PixelOnlyState,
  type PixelPlayer,
  RASTER_SIZE,
} from "@suup/avatar";
import { getPixelClock } from "@suup/avatar/browser";
import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import { cx } from "../lib/cx.js";
import { useReducedMotion } from "../lib/reduced-motion.js";
import { DONE_HOLD_MS, MascotHostContext, type MascotProps, useBriefDone } from "./mascot.js";

// O segundo estilo de avatar: os 17 mascotes pixelados que o dono desenhou. Mesmo papel do
// `Mascot` (formas): o Avatar escolhe um dos dois. Desenha num canvas com escala INTEIRA
// (cada célula da grade de 19 x 19 ocupa um número inteiro de pixels do aparelho, com
// `devicePixelRatio`), sem suavização; o movimento vem do relógio compartilhado do motor.

export interface PixelMascotProps extends Pick<MascotProps, "state" | "size" | "still" | "picked"> {
  character: PixelCharacterId;
  /** A cor do bot; `null` mantém a cor do desenho do dono. */
  color: BotColor | null;
  /** Identidade (o id do bot): define em que ponto do ciclo o avatar parado começa. */
  seed?: string;
  /** Um dos dois estados que só o pixel tem (ver `PixelOnlyState`); ganha do `state`. */
  pose?: PixelOnlyState;
  /** Opção: o desenho como sólido 3D que balança (em pixels). Desligada por padrão. */
  pixel3d?: boolean;
}

export function PixelMascot({
  character,
  color,
  state = "idle",
  size = "md",
  seed = character,
  still = false,
  picked = false,
  pose,
  pixel3d = false,
}: PixelMascotProps) {
  const host = useContext(MascotHostContext);
  const systemReduced = useReducedMotion();
  const reduced = host.reducedMotion ?? systemReduced;
  const shown = useBriefDone(state, host.doneHoldMs ?? DONE_HOLD_MS);
  const animated = !still && !reduced && size !== "xs";
  const frame = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<{ player: PixelPlayer; paint(now: number): void } | null>(null);
  const latest = useRef<PixelMascotProps["pose"] | typeof shown>(pose ?? shown);

  const pixel = useMemo(
    () =>
      createPixelCharacter({
        id: seed,
        character,
        color: color === null ? null : BOT_PALETTE[color].fill,
      }),
    [seed, character, color],
  );

  useLayoutEffect(() => {
    latest.current = pose ?? shown;
  });

  const clockOverride = host.pixelClock;
  useLayoutEffect(() => {
    const box = frame.current;
    const el = canvas.current;
    if (box === null || el === null) return;
    const player = createPixelPlayer(pixel, {
      state: latest.current ?? "idle",
      reducedMotion: !animated,
      pixel3d,
    });
    let layout: PixelLayout = layoutPixels(0);
    let ratio = 1;
    let lastKey = "";
    const measure = () => {
      const rect = box.getBoundingClientRect();
      ratio = window.devicePixelRatio || 1;
      const side = Math.min(rect.width, rect.height);
      // 3D: the image has a margin around the 19 x 19 grid (room for the turned solid). The canvas
      // is drawn that much bigger than the box, overflowing it evenly, so each cell is as big as in
      // the flat drawing and the mascot keeps the size of the shapes (owner, 23/11/2026: "no 3D o
      // mascote fica minúsculo"); the margin is transparent.
      layout = pixel3d
        ? layoutPixels((side * RASTER_SIZE) / PIXEL_GRID, ratio, RASTER_SIZE)
        : layoutPixels(side, ratio);
      el.width = layout.buffer;
      el.height = layout.buffer;
      // O estilo mede o buffer em pixels CSS: a tela não reescala (e não borra) o desenho.
      el.style.width = `${layout.buffer / ratio}px`;
      el.style.height = `${layout.buffer / ratio}px`;
      lastKey = "";
    };
    const paint = (now: number) => {
      if (pixel3d) {
        // 3D: o quadro muda a cada instante (giro); o movimento reduzido é a vista de frente.
        const ctx3 = el.getContext("2d");
        if (ctx3 === null) return;
        drawPixelImage(ctx3, player.frame3dAt(now), layout);
        return;
      }
      const quadro = player.frameAt(now);
      const key = `${quadro.key}|${bobPixels(quadro, layout)}|${layout.buffer}|${pixel.color}`;
      if (key === lastKey) return;
      const ctx = el.getContext("2d");
      if (ctx === null) return;
      lastKey = key;
      drawPixelFrame(ctx, pixel, quadro, layout);
    };
    measure();
    live.current = { player, paint };
    let handle: PixelClockHandle | null = null;
    if (animated) {
      handle = (clockOverride ?? getPixelClock()).register({ paint, element: el });
    } else {
      paint(0);
    }
    const resize = () => {
      measure();
      paint(performance.now());
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(box);
    window.addEventListener("resize", resize);
    return () => {
      handle?.unregister();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      live.current = null;
    };
  }, [animated, pixel, clockOverride, pixel3d]);

  const current = pose ?? shown;
  useLayoutEffect(() => {
    const now = live.current;
    if (now === null) return;
    now.player.setState(current);
    now.paint(performance.now());
  }, [current, animated, pixel, clockOverride]);

  return (
    <span
      ref={frame}
      className={cx(
        "inline-flex size-full items-center justify-center",
        picked && "filter-(--filter-mascot-picked)",
      )}
      data-mascot={character}
      data-mascot-style="pixel"
      data-pixel3d={pixel3d ? "true" : undefined}
      data-color={color ?? "original"}
      data-state={current}
      data-mode={animated ? "animated" : "still"}
      aria-hidden="true"
    >
      <canvas ref={canvas} className="block flex-none" style={{ imageRendering: "pixelated" }} />
    </span>
  );
}
