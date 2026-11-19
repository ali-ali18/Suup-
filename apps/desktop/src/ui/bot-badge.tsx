import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";

/**
 * What a bot's badge says: `question`, `unread` and `failed` carry a short text (a count, "?", "!");
 * `paused` and `working` are only a dot (`working` pulses).
 */
const BADGE_KIND = {
  question: "h-4 min-w-4 bg-bg-inverse px-1 text-text-inverse",
  unread: "h-4 min-w-4 bg-bg-inverse px-1 text-text-inverse",
  failed: "h-4 min-w-4 bg-danger-text px-1 text-text-inverse",
  paused: "size-3 bg-text-muted",
  working: "size-3 animate-badge bg-text-muted",
} as const;

export type BadgeKind = keyof typeof BADGE_KIND;

/** The small round mark on a bot's face (its count of waiting things, or what it is doing). */
export function BotBadge({
  kind,
  children,
  ...rest
}: { kind: BadgeKind; children?: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(
        "absolute -top-0.5 -right-1 inline-flex items-center justify-center rounded-pill border-2 border-bg text-badge leading-none font-label",
        BADGE_KIND[kind],
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
