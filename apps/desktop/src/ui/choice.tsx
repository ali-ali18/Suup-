import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";

/**
 * A native checkbox. It keeps the margin the browser gives it (3 px around, 4 px at the start): the
 * reset takes it away, and the layout of every list of choices was drawn with it. (A radio is
 * `Radio` of `ui/radio.tsx`.)
 */
export function CheckInput({
  type,
  ...rest
}: { type: "checkbox" } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type={type} className="m-0.75 ml-1" {...rest} />;
}

/**
 * A pill that is on or off (a tool of the bot, a day of the week): on is filled with the text
 * colour, so the chosen ones stand out at a glance; off is only outlined. (One option of a
 * group is `RadioChip` of `ui/radio.tsx`.)
 */
export function ToggleChip({
  on,
  children,
  className,
  type,
  ...rest
}: {
  on: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type ?? "button"}
      aria-pressed={on}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-small",
        on
          ? "border-text bg-text text-text-inverse"
          : "border-border-strong bg-transparent text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
