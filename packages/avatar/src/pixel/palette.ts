// Cores de um personagem pixel: as do Figma por padrão; a cor do bot, quando há, pinta o corpo
// (do mesmo jeito que o estilo de formas: o corpo leva a cor do bot, o resto contrasta).

/** Cores fixas do desenho do dono (fora o corpo, que é por personagem). */
export const PIXEL_INK = {
  /** Olho aberto e detalhe branco dos símbolos (`#ffffff`). */
  white: "#ffffff",
  /** Símbolos e olho fechado (`#1b1f3b`). */
  dark: "#1b1f3b",
  /** Raios da lâmpada (`#ffd23f`). */
  lamp: "#ffd23f",
  /** Brilho da lâmpada acesa (`#fff0a8`). */
  glow: "#fff0a8",
} as const;

const HEX_DIGITS = "0123456789abcdefABCDEF";

/** `#rrggbb` (só esta forma; é o que a paleta do app e o Figma usam). `null` se não for. */
export function parseHexColor(value: string | null | undefined): [number, number, number] | null {
  const text = value?.trim();
  if (text === undefined || text.length !== 7 || text[0] !== "#") return null;
  for (let i = 1; i < 7; i++) if (!HEX_DIGITS.includes(text.charAt(i))) return null;
  const channel = (at: number) => Number.parseInt(text.slice(at, at + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

function luminance(rgb: readonly [number, number, number]): number {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** O corpo é tão claro que o olho branco some. */
const LIGHT_BODY = 0.82;
/** O corpo é tão escuro que o olho fechado (tinta escura) some. */
const DARK_BODY = 0.2;

export type PixelPalette = {
  /** Corpo (e pontos de "pensando"). */
  body: string;
  /** Olho aberto. */
  eye: string;
  /** Olho fechado / dormindo (linha escura). */
  eyeClosed: string;
  dark: string;
  white: string;
  lamp: string;
  glow: string;
};

/** Paleta do personagem: `bodyColor` do desenho, trocada por `tint` (`#rrggbb`) se houver. */
export function paletteFor(bodyColor: string, tint?: string | null): PixelPalette {
  const tinted = parseHexColor(tint);
  const body = tinted ? (tint as string).trim().toLowerCase() : bodyColor;
  const lum = tinted ? luminance(tinted) : 0.5;
  return {
    body,
    eye: tinted && lum >= LIGHT_BODY ? PIXEL_INK.dark : PIXEL_INK.white,
    eyeClosed: tinted && lum <= DARK_BODY ? PIXEL_INK.white : PIXEL_INK.dark,
    dark: PIXEL_INK.dark,
    white: PIXEL_INK.white,
    lamp: PIXEL_INK.lamp,
    glow: PIXEL_INK.glow,
  };
}
