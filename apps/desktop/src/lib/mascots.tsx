import { BOT_PALETTE, type BotColor } from "@suup/api";

/**
 * The six mascots of the design (Figma page 0:1, "Estilo Grok — motor Atlas": Folha, Gota, Cunha,
 * Esfera, Cápsula, Trevo), redrawn as simple SVG shapes so they can be painted with any colour of
 * the palette. `bot.avatar` holds `mascot:<id>`; `bot.color` an id of `BOT_PALETTE`.
 */
export const MASCOTS = [
  { id: "folha", name: "Folha", color: "laranja" },
  { id: "gota", name: "Gota", color: "cinza" },
  { id: "cunha", name: "Cunha", color: "azul" },
  { id: "esfera", name: "Esfera", color: "grafite" },
  { id: "capsula", name: "Cápsula", color: "verde" },
  { id: "trevo", name: "Trevo", color: "roxo" },
] as const satisfies readonly { id: string; name: string; color: BotColor }[];

export type MascotId = (typeof MASCOTS)[number]["id"];

export const mascotValue = (id: MascotId): string => `mascot:${id}`;

export interface AvatarSpec {
  kind: "mascot" | "emoji";
  /** The mascot's shape id (kind `mascot`). */
  id?: MascotId;
  /** The emoji (kind `emoji`). */
  text?: string;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * `bot.avatar` is an opaque string the server only stores: `mascot:<id>` is one of the six
 * mascots, other text is an emoji, and `null` is a mascot chosen from the bot's id so a bot always
 * looks the same.
 */
export function avatarOf(avatar: string | null, seed: string): AvatarSpec {
  if (avatar?.startsWith("mascot:")) {
    const found = MASCOTS.find((m) => m.id === avatar.slice("mascot:".length));
    if (found !== undefined) return { kind: "mascot", id: found.id };
  } else if (avatar !== null && avatar.trim() !== "") {
    return { kind: "emoji", text: avatar };
  }
  const pick = MASCOTS[hash(seed) % MASCOTS.length] ?? MASCOTS[0];
  return { kind: "mascot", id: pick.id };
}

/** The colour a bot is painted with: its own, else its mascot's. */
export function effectiveColor(
  avatar: string | null,
  color: BotColor | null,
  seed: string,
): BotColor {
  if (color !== null) return color;
  const spec = avatarOf(avatar, seed);
  return MASCOTS.find((m) => m.id === spec.id)?.color ?? "cinza";
}

export const paletteOf = (color: BotColor): { fill: string; onFill: string } => BOT_PALETTE[color];

/** The CSS custom properties of a bot's colour: set on a container; the user's bubble and the send button read them. */
export function colorVars(color: BotColor): Record<string, string> {
  const p = BOT_PALETTE[color];
  return {
    "--bot-fill": p.fill,
    "--bot-on-fill": p.onFill,
    "--bot-bubble": p.userBubbleFill,
    "--bot-on-bubble": p.userBubbleOnFill,
  };
}
