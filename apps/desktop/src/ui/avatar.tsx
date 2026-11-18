import type { BotColor } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";
import { avatarOf, effectiveColor } from "../lib/mascots.js";
import { Mascot, type MascotSize } from "./mascot.js";

export interface AvatarProps {
  /** `bot.avatar` (opaco), `bot.color` e uma semente (o id do bot) para o que o bot não tem. */
  avatar: string | null;
  color?: BotColor | null;
  seed: string;
  size?: MascotSize;
  /** O que o bot está fazendo (ver `avatarStateOf`); o emoji não reage. */
  state?: AvatarStateId;
  /** Sempre imagem parada. */
  still?: boolean;
  title?: string;
}

/** O rosto do bot: o mascote na cor dele (ou um emoji). */
export function Avatar({
  avatar,
  color = null,
  seed,
  size = "md",
  state = "idle",
  still = false,
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
          color={effectiveColor(color, seed)}
          state={state}
          size={size}
          seed={seed}
          still={still}
        />
      ) : (
        <span className="ui-avatar__emoji">{spec.text}</span>
      )}
    </span>
  );
}
