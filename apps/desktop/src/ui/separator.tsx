/*
 * Our copy of the shadcn `separator` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Separator (`role="separator"`). Rewritten to our tokens: a 1 px line of
 * `--color-border` (or the stronger one). Every divider of a popup or a list is this piece, never a
 * hand-made rule element or a border on a `div` (owner, 24/11/2026). The menus use Base UI's
 * `Menu.Separator` with the same line (`SEPARATOR_LINE`).
 */
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cx } from "../lib/cx.js";

/** The line itself: horizontal is a 1 px row, vertical a 1 px column. */
export const SEPARATOR_LINE = {
  horizontal: "h-px flex-none",
  vertical: "w-px flex-none self-stretch",
} as const;

const TONE = { normal: "bg-border", strong: "bg-border-strong" } as const;

export function Separator({
  orientation = "horizontal",
  tone = "normal",
  className,
}: {
  orientation?: keyof typeof SEPARATOR_LINE;
  tone?: keyof typeof TONE;
  /** Position only (a margin, a width): the line itself is the component's. */
  className?: string;
}) {
  return (
    <SeparatorPrimitive
      orientation={orientation}
      className={cx(SEPARATOR_LINE[orientation], TONE[tone], className)}
    />
  );
}
