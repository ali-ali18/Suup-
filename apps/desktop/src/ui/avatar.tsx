import type { BotColor } from "@suup/api";
import type { Reaction } from "../data/derive.js";
import { avatarOf, effectiveColor } from "../lib/mascots.js";
import { Mascot, type MascotSize } from "./mascot.js";

export interface AvatarProps {
  /** `bot.avatar` (opaque), `bot.color` and a seed (the bot id) for bots that have none. */
  avatar: string | null;
  color?: BotColor | null;
  seed: string;
  size?: MascotSize;
  reaction?: Reaction;
  /** The bot is working: its face is replaced by three dots. */
  working?: boolean;
  title?: string;
}

/** The bot's face: its mascot in its colour (or an emoji). */
export function Avatar({
  avatar,
  color = null,
  seed,
  size = "md",
  reaction = "idle",
  working = false,
  title,
}: AvatarProps) {
  const spec = avatarOf(avatar, seed);
  return (
    <span
      className={`ui-avatar ui-avatar--${size}`}
      {...(title === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": title })}
    >
      {spec.kind === "mascot" && spec.id !== undefined ? (
        <Mascot
          shape={spec.id}
          color={effectiveColor(avatar, color, seed)}
          state={working ? "working" : "idle"}
          size={size}
          reaction={reaction}
        />
      ) : (
        <span className="ui-avatar__emoji">{spec.text}</span>
      )}
    </span>
  );
}
