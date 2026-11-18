import { BOT_PALETTE, type BotColor } from "@suup/api";
import type { MascotId } from "../lib/mascots.js";
import { Dots } from "./chat-lines.js";

// THE place where the bots' faces are drawn. The owner's mascot engine for this style does not exist
// yet: these six shapes are simple placeholders, so the real engine can replace what is inside
// `Mascot` without touching a single caller. Nothing else in the app draws a mascot.

const BODY: Record<MascotId, string> = {
  folha: "M10 28C10 17 17 9 25 9c5 0 9 3 12 8 2 4 2 9 0 13-3 6-9 10-16 10-7 0-11-5-11-12Z",
  gota: "M24 6c6 8 14 15 14 25a14 14 0 0 1-28 0C10 21 18 14 24 6Z",
  cunha: "M6 40c0-10 4-21 10-28 5-5 13-5 18 1 5 6 8 14 8 21 0 4-3 6-7 6H10c-3 0-4-1-4 0Z",
  esfera: "M24 8a17 17 0 1 0 0.01 0Z",
  capsula: "M24 8c8.3 0 15 6.7 15 15v4c0 8.3-6.7 15-15 15S9 35.3 9 27v-4C9 14.700 15.700 8 24 8Z",
  trevo:
    "M24 8c4 0 7 3 7 7 4 0 8 3 8 8s-4 8-8 8c0 5-3 9-7 9s-7-4-7-9c-4 0-8-3-8-8s4-8 8-8c0-4 3-7 7-7Z",
};

export type MascotSize = "xs" | "sm" | "md" | "lg" | "xl" | "tile";
export type MascotState = "idle" | "working";

export interface MascotProps {
  shape: MascotId;
  color: BotColor;
  /** `working`: the face is replaced by three dots (the bot is working). */
  state?: MascotState;
  size?: MascotSize;
  /** A small animation of the face (the avatar's reaction); the placeholder only bobs or shakes. */
  reaction?: string;
}

export function Mascot({
  shape,
  color,
  state = "idle",
  size = "md",
  reaction = "idle",
}: MascotProps) {
  const { fill, onFill } = BOT_PALETTE[color];
  return (
    <span className={`ui-mascot ui-mascot--${size}`} data-state={state} data-reaction={reaction}>
      {state === "working" ? (
        <span className="ui-mascot__dots" data-testid="bot-dots">
          <Dots size={size === "xs" || size === "sm" || size === "md" ? "md" : "lg"} />
        </span>
      ) : (
        <svg
          viewBox="5 5 38 38"
          fill="none"
          aria-hidden="true"
          focusable="false"
          data-mascot={shape}
          data-color={color}
        >
          <path d={BODY[shape]} fill={fill} />
          <rect x="14.5" y="21" width="5" height="9" rx="2.5" fill={onFill} />
          <rect x="26.5" y="19.5" width="5" height="9" rx="2.5" fill={onFill} />
        </svg>
      )}
    </span>
  );
}
