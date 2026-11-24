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

/**
 * The corner of the avatar (the owner's own design, from his previous project): ONE status in the
 * lower right corner, by precedence: working (a green dot) > unread (a blue dot) > the main bot's
 * star. The face is never replaced, only notched around the mark. Sizes come from tokens: the star
 * is FIXED (12 px under 44 px, 16 px from 44 px); the dot follows the avatar (10 to 16 px). None on
 * the 16 px avatar (no room).
 */
interface Corner {
  /** The star's marker, its glyph, and the token of its size and gap (for the notch). */
  star: { badge: string; glyph: string; size: string; gap: string };
  /** The dot's class and the token of its size. */
  dot: { box: string; size: string };
}
const SMALL_STAR = {
  badge: "size-star-badge",
  glyph: "size-star-glyph",
  size: "--size-star-badge",
  gap: "--size-star-gap",
};
const LARGE_STAR = {
  badge: "size-star-badge-lg",
  glyph: "size-star-glyph-lg",
  size: "--size-star-badge-lg",
  gap: "--size-star-gap-lg",
};
const dot = (name: "sm" | "row" | "lg" | "xl") => ({
  box: `size-status-dot-${name}`,
  size: `--size-status-dot-${name}`,
});
const CORNER: Partial<Record<AvatarSize, Corner>> = {
  sm: { star: SMALL_STAR, dot: dot("sm") },
  md: { star: SMALL_STAR, dot: dot("sm") },
  row: { star: SMALL_STAR, dot: dot("row") },
  lg: { star: LARGE_STAR, dot: dot("lg") },
  tile: { star: LARGE_STAR, dot: dot("xl") },
  xl: { star: LARGE_STAR, dot: dot("xl") },
  preview: { star: LARGE_STAR, dot: dot("xl") },
};

/** What the corner shows, by precedence. */
export type CornerStatus = "working" | "unread" | "primary" | "none";
export function cornerStatus(s: {
  working?: boolean;
  unread?: boolean;
  primary?: boolean;
}): CornerStatus {
  if (s.working === true) return "working";
  if (s.unread === true) return "unread";
  if (s.primary === true) return "primary";
  return "none";
}

/**
 * How far the face's layer reaches past the avatar's box on every side, as a fraction of the box.
 * The engine frames some shapes (the sparkle, the star, the flower, the crystal...) a little bigger
 * than the box, so a mask that ends AT the box would cut them flat. The layer is bigger than the box
 * and the mask is only the notch; everything outside the notch is opaque, so nothing else is cut.
 */
export const FACE_BLEED = 0.35;
const percent = (fraction: number) => `${Math.round(fraction * 1e4) / 100}%`;
/** The layer's inset (negative) and padding that put its content box exactly over the avatar's box. */
const FACE_LAYER = {
  inset: percent(-FACE_BLEED),
  padding: percent(FACE_BLEED / (1 + 2 * FACE_BLEED)),
} as const;

/**
 * The notch: a radial mask that opens a circle, a little bigger than the mark, in the lower right
 * corner of the AVATAR (the mask lives on the face's layer, which is `FACE_BLEED` bigger than the
 * box on every side). Built from the tokens' names, so the numbers live only in tokens.css.
 */
export function cornerMask(sizeToken: string, gapToken: string): string {
  const r = `var(${sizeToken}) / 2`;
  const edge = percent((1 + FACE_BLEED) / (1 + 2 * FACE_BLEED));
  return `radial-gradient(circle at calc(${edge} - ${r}) calc(${edge} - ${r}), transparent calc(${r} + var(${gapToken})), var(--color-mask) calc(${r} + var(${gapToken}) + 0.5px))`;
}

const DOT_TEXT = { working: "Trabalhando", unread: "Mensagem não lida" } as const;
const DOT_BG = { working: "bg-status-working", unread: "bg-status-unread" } as const;

/** The star of the marker: the 24 x 24 path of the owner's design, filled. */
const STAR_PATH =
  "M12 17.27l4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72 3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18-1.1 4.72c-.2.86.73 1.54 1.49 1.08L12 17.27z";

export interface AvatarProps {
  /** `bot.avatar` (opaco), `bot.color` e uma semente (o id do bot) para o que o bot não tem. */
  avatar: string | null;
  /** A família do mascote que `avatar` nomeia (`bot.avatarStyle`); sem ela, as formas. */
  avatarStyle?: AvatarStyle | undefined;
  /** O mascote pixel em 3D (`bot.avatarPixel3d`); só vale no estilo pixel. */
  pixel3d?: boolean | undefined;
  color?: BotColor | null;
  seed: string;
  size?: AvatarSize;
  /** O que o bot está fazendo (ver `avatarStateOf`); o emoji não reage. */
  state?: AvatarStateId;
  /** Sempre imagem parada. */
  still?: boolean;
  /** O avatar vivo do chat: o movimento de cada atividade mesmo pequeno (ver `Mascot`). */
  lively?: boolean;
  title?: string;
  /**
   * É o bot principal, o supervisor da equipe: uma estrela pequena e calma no canto (a única marca
   * que um avatar tem além do rosto; docs/DESIGN.md §5). Vale para qualquer estilo de rosto, porque
   * é desenhada em volta dele, não dentro.
   */
  supervisor?: boolean;
  /** The bot is working now: the green dot in the corner (over the star). */
  working?: boolean;
  /** The bot has a message you have not read: the blue dot (over the star, under "working"). */
  unread?: boolean;
}

/** O rosto do bot: o mascote na cor dele (ou um emoji). */
export function Avatar({
  avatar,
  avatarStyle = "shapes",
  pixel3d = false,
  color = null,
  seed,
  size = "md",
  state = "idle",
  still = false,
  lively = false,
  title,
  supervisor = false,
  working = false,
  unread = false,
}: AvatarProps) {
  const spec = avatarOf(avatar, seed, avatarStyle);
  const corner = CORNER[size];
  const status =
    corner === undefined ? "none" : cornerStatus({ working, unread, primary: supervisor });
  const notch =
    corner === undefined || status === "none"
      ? undefined
      : status === "primary"
        ? cornerMask(corner.star.size, corner.star.gap)
        : cornerMask(corner.dot.size, "--size-status-gap");
  return (
    <span
      className={cx(
        "relative inline-flex flex-none items-center justify-center rounded-full",
        AVATAR_SIZE[size],
      )}
      {...(title === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": title })}
    >
      {/* The face, notched where the star sits (a mask, not a ring): it is the same for every style. */}
      <span
        className="absolute box-border inline-flex items-center justify-center"
        data-face-layer=""
        style={{
          inset: FACE_LAYER.inset,
          padding: FACE_LAYER.padding,
          ...(notch === undefined
            ? {}
            : {
                maskImage: notch,
                WebkitMaskImage: notch,
                maskRepeat: "no-repeat",
                WebkitMaskRepeat: "no-repeat",
              }),
        }}
        data-testid={notch === undefined ? undefined : "avatar-notch"}
      >
        {spec.pixel !== undefined ? (
          <PixelMascot
            character={spec.pixel}
            color={color}
            state={state}
            size={MASCOT_OF[size]}
            seed={seed}
            still={still}
            pixel3d={pixel3d}
          />
        ) : spec.kind === "mascot" && spec.id !== undefined ? (
          <Mascot
            shape={spec.id}
            color={effectiveColor(color, seed)}
            state={state}
            size={MASCOT_OF[size]}
            seed={seed}
            still={still}
            lively={lively}
          />
        ) : (
          <span className="text-[1.1em] leading-none">{spec.text}</span>
        )}
      </span>
      {corner !== undefined && status === "primary" && (
        <span
          className={cx(
            "absolute right-0 bottom-0 grid place-items-center rounded-full bg-star-badge text-star-glyph shadow-star-badge",
            corner.star.badge,
          )}
          data-testid="supervisor-star"
          role="img"
          aria-label="Bot principal"
          title="Bot principal"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={corner.star.glyph}
            aria-hidden="true"
          >
            <path d={STAR_PATH} />
          </svg>
        </span>
      )}
      {corner !== undefined && (status === "working" || status === "unread") && (
        <span
          className={cx(
            "absolute right-0 bottom-0 animate-fade-in rounded-full",
            corner.dot.box,
            DOT_BG[status],
          )}
          data-testid="avatar-dot"
          data-status={status}
          role="img"
          aria-label={DOT_TEXT[status]}
        />
      )}
    </span>
  );
}
