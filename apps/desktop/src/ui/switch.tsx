/*
 * Our copy of the shadcn `switch` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Switch. The classes are rewritten to our tokens (docs/DESIGN.md §2a):
 * the 40 x 24 track of the app, the dark-grey/white or the blue routine colours, our focus ring.
 */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { BOT_PALETTE, type BotColor } from "@suup/api";
import { cx } from "../lib/cx.js";

/**
 * The track: `neutral` is the app's (white when on), `accent` the blue switch of the routines and
 * `bot` the one of a specific bot (its colour when on; owner's decision, 24/11/2026).
 */
const TRACK = {
  neutral: "border-border-strong data-checked:bg-bg-inverse data-unchecked:bg-raised",
  accent: "border-transparent data-checked:bg-switch-on data-unchecked:bg-switch-off",
  bot: "border-transparent data-checked:bg-bot-fill data-unchecked:bg-switch-off",
} as const;

const THUMB = {
  neutral: "data-checked:bg-text-inverse data-unchecked:bg-text-muted",
  accent: "data-checked:bg-switch-knob-on data-unchecked:bg-switch-knob-off",
  bot: "data-checked:bg-switch-knob-on data-unchecked:bg-switch-knob-off",
} as const;

/** The colour a bot's switch is when on: the bot's own, and blue for the white bot (white on white would vanish). */
export function switchColor(color: BotColor): BotColor {
  return color === "branco" ? "azul" : color;
}

/**
 * The on/off switch (`role="switch"`, `aria-checked`): a native button, so Space and Enter flip it
 * and `disabled` is the button's own. Base UI keeps a hidden checkbox beside it (`aria-hidden`).
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  testId,
  accent,
  color,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
  testId?: string;
  /** The blue switch (the routines of the panel; owner's decision, 22/11/2026): on is blue, off is dark grey. */
  accent?: boolean;
  /**
   * The switch of a specific bot (the supervisor of a bot being made...): on, it takes that bot's
   * colour, or blue when the bot is white. Without it, the app's own switch.
   */
  color?: BotColor;
}) {
  const tone = color !== undefined ? "bot" : accent === true ? "accent" : "neutral";
  return (
    <SwitchPrimitive.Root
      nativeButton
      render={<button type="button" />}
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      data-color={color !== undefined ? switchColor(color) : undefined}
      style={
        color !== undefined
          ? ({ "--bot-fill": BOT_PALETTE[switchColor(color)].fill } as React.CSSProperties)
          : undefined
      }
      className={cx(
        "relative inline-flex h-6 w-10 flex-none items-center rounded-pill border p-0 transition-colors data-disabled:opacity-40",
        TRACK[tone],
      )}
    >
      <SwitchPrimitive.Thumb
        className={cx(
          "pointer-events-none absolute top-0.5 left-0.5 size-4.5 rounded-pill transition-transform data-checked:translate-x-4",
          THUMB[tone],
        )}
      />
    </SwitchPrimitive.Root>
  );
}
