import type { AvatarStyle, BotColor } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";
import { cx } from "../lib/cx.js";
import { avatarOf, effectiveColor } from "../lib/mascots.js";
import { Mascot, type MascotSize } from "./mascot.js";
import { PixelMascot } from "./pixel-mascot.js";

/** `row` is the bots list row (42 px), `preview` the big face of the new-bot dialog (120 px). */
const AVATAR_SIZE = {
  xs: "size-4 text-glyph-xs",
  sm: "size-7.25",
  md: "size-avatar-md",
  row: "size-10.5",
  lg: "size-rail-avatar",
  xl: "size-18.5 text-glyph-xl",
  preview: "size-30 text-glyph-xl",
  tile: "size-16.5 text-glyph-tile",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE;

/** The size of the mascot inside (it moves less in the small ones): `row` and `preview` borrow one. */
const MASCOT_OF: Record<AvatarSize, MascotSize> = {
  xs: "xs",
  sm: "sm",
  md: "md",
  row: "md",
  lg: "lg",
  xl: "xl",
  preview: "xl",
  tile: "tile",
};

export interface AvatarProps {
  /** `bot.avatar` (opaco), `bot.color` e uma semente (o id do bot) para o que o bot não tem. */
  avatar: string | null;
  /** A família do mascote que `avatar` nomeia (`bot.avatarStyle`); sem ela, as formas. */
  avatarStyle?: AvatarStyle | undefined;
  color?: BotColor | null;
  seed: string;
  size?: AvatarSize;
  /** O que o bot está fazendo (ver `avatarStateOf`); o emoji não reage. */
  state?: AvatarStateId;
  /** Sempre imagem parada. */
  still?: boolean;
  title?: string;
}

/** O rosto do bot: o mascote na cor dele (ou um emoji). */
export function Avatar({
  avatar,
  avatarStyle = "shapes",
  color = null,
  seed,
  size = "md",
  state = "idle",
  still = false,
  title,
}: AvatarProps) {
  const spec = avatarOf(avatar, seed, avatarStyle);
  return (
    <span
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full",
        AVATAR_SIZE[size],
      )}
      {...(title === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": title })}
    >
      {spec.pixel !== undefined ? (
        <PixelMascot
          character={spec.pixel}
          color={color}
          state={state}
          size={MASCOT_OF[size]}
          seed={seed}
          still={still}
        />
      ) : spec.kind === "mascot" && spec.id !== undefined ? (
        <Mascot
          shape={spec.id}
          color={effectiveColor(color, seed)}
          state={state}
          size={MASCOT_OF[size]}
          seed={seed}
          still={still}
        />
      ) : (
        <span className="text-[1.1em] leading-none">{spec.text}</span>
      )}
    </span>
  );
}
