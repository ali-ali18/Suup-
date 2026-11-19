import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";

/**
 * A native checkbox or radio. It keeps the margin the browser gives it (3 px around, 4 px at the
 * start): the reset takes it away, and the layout of every list of choices was drawn with it.
 */
export function CheckInput({
  type,
  ...rest
}: { type: "checkbox" | "radio" } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type={type} className="m-0.75 ml-1" {...rest} />;
}

/** A group of choices (radios) with a legend that only a screen reader reads. */
export function ChoiceGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend className="sr-only">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** One radio and its text. */
export function ChoiceRow({
  name,
  checked,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  onChange(): void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <CheckInput type="radio" name={name} checked={checked} onChange={onChange} /> {children}
    </label>
  );
}

/** A pill that is on or off (a tool of the bot): the border and the fill say which. */
export function ToggleChip({
  on,
  children,
  className,
  type,
  ...rest
}: { on: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type ?? "button"}
      aria-pressed={on}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-small",
        on ? "border-text bg-raised" : "border-border-strong bg-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
