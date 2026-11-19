// Quem acompanha UM avatar pixel: personagem, estado, desde quando está nele. Puro (o relógio vem
// de fora, em ms de qualquer relógio monotônico).
import type { PixelCharacter } from "./character.js";
import { type PixelFrame, pixelFrameAt, pixelStill } from "./frame.js";
import type { PixelStateInput } from "./states.js";

export type PixelPlayerOptions = {
  state?: PixelStateInput;
  /** Movimento reduzido: sempre a pose parada do Figma, sem balançar, piscar nem acender pontos. */
  reducedMotion?: boolean;
};

export type PixelPlayer = {
  setCharacter(character: PixelCharacter): void;
  setState(state: PixelStateInput): void;
  setReducedMotion(reduced: boolean): void;
  readonly character: PixelCharacter;
  readonly state: PixelStateInput;
  /** `true` se o quadro muda com o tempo (precisa do relógio). */
  readonly animated: boolean;
  /** O quadro em `nowMs`. A pose conta a partir da primeira chamada depois de mudar de estado. */
  frameAt(nowMs: number): PixelFrame;
};

export function createPixelPlayer(
  initial: PixelCharacter,
  options: PixelPlayerOptions = {},
): PixelPlayer {
  let character = initial;
  let state: PixelStateInput = options.state ?? "idle";
  let reduced = options.reducedMotion ?? false;
  let startedAt: number | null = null;
  return {
    setCharacter(next) {
      character = next;
    },
    setState(next) {
      if (next === state) return;
      state = next;
      startedAt = null;
    },
    setReducedMotion(next) {
      reduced = next;
    },
    get character() {
      return character;
    },
    get state() {
      return state;
    },
    get animated() {
      return !reduced;
    },
    frameAt(nowMs) {
      if (reduced) return pixelStill(character, state);
      startedAt ??= nowMs;
      return pixelFrameAt(character, state, nowMs - startedAt);
    },
  };
}
