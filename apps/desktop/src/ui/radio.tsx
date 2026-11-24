/*
 * Our copy of the shadcn `radio-group` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's RadioGroup and Radio. The classes are rewritten to our tokens
 * (docs/DESIGN.md §2a): the checked radio is FILLED with the text colour and its dot is the inverted
 * one (the owner's rule, 22/11/2026), not the accent fill of the shadcn original; the focus ring is ours.
 *
 * Each radio is a native `<button>` (Base UI's own recommendation when the label is a sibling,
 * `htmlFor` and `id`): the role is `radio`, `aria-checked` is Base UI's, and the arrows, Home and End
 * move the focus and the choice inside the group, one tab stop for the whole group.
 */
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cx } from "../lib/cx.js";

/** What a radio accepts besides what each piece sets itself (they are native buttons). */
type RadioProps = Omit<
  ComponentProps<typeof RadioPrimitive.Root>,
  "value" | "nativeButton" | "render" | "className" | "children"
>;

const FOCUS = "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2";

/** The group (`role="radiogroup"`): its name is `label`, which only a screen reader reads. `className` replaces the column layout. */
export function RadioGroup({
  label,
  value,
  onValueChange,
  className,
  children,
  ...rest
}: {
  label: string;
  value: string;
  onValueChange(value: string): void;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "defaultValue" | "onChange" | "dir">) {
  return (
    <RadioGroupPrimitive
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      className={className ?? "flex flex-col gap-3"}
      {...rest}
    >
      {children}
    </RadioGroupPrimitive>
  );
}

/** A radio with no look of its own (a swatch, a mascot): the caller draws it; `aria-label` names it. */
export function RadioButton({
  value,
  className,
  children,
  ...rest
}: { value: string; className?: string; children?: ReactNode } & RadioProps) {
  return (
    <RadioPrimitive.Root
      nativeButton
      render={<button type="button" />}
      value={value}
      className={className}
      {...rest}
    >
      {children}
    </RadioPrimitive.Root>
  );
}

/** The round radio: an outline, filled with the text colour and a dot of the inverted one when on. */
export function Radio({ value, id, disabled, ...rest }: { value: string } & RadioProps) {
  return (
    <RadioPrimitive.Root
      nativeButton
      render={<button type="button" />}
      value={value}
      id={id}
      disabled={disabled}
      className={cx(
        "inline-flex size-4.5 flex-none items-center justify-center rounded-pill border-[1.5px] p-0 transition-colors data-checked:border-text data-checked:bg-text data-disabled:opacity-40 data-unchecked:border-border-strong data-unchecked:bg-transparent",
        FOCUS,
      )}
      {...rest}
    >
      <RadioPrimitive.Indicator className="block size-1.5 rounded-pill bg-text-inverse" />
    </RadioPrimitive.Root>
  );
}

/** One row: the radio and its text, a `label` beside it (the sibling pattern), so a click on the text chooses it. */
export function RadioRow({
  value,
  disabled,
  children,
}: {
  value: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Radio value={value} id={id} {...(disabled === undefined ? {} : { disabled })} />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

const CHIP_SIZE = {
  sm: "h-8 px-3 text-small",
  md: "h-control px-4.5 text-label font-label",
} as const;

/**
 * A radio drawn as a pill (the style of the avatar, the kind of a connector): on is filled with the
 * text colour, off is only outlined, like the on/off `ToggleChip`.
 */
export function RadioChip({
  value,
  size = "sm",
  className,
  children,
  ...rest
}: {
  value: string;
  size?: keyof typeof CHIP_SIZE;
  className?: string;
  children?: ReactNode;
} & RadioProps) {
  return (
    <RadioPrimitive.Root
      nativeButton
      render={<button type="button" />}
      value={value}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-pill border whitespace-nowrap data-checked:border-text data-checked:bg-text data-checked:text-text-inverse data-unchecked:border-border-strong data-unchecked:bg-transparent data-unchecked:text-text",
        CHIP_SIZE[size],
        FOCUS,
        className,
      )}
      {...rest}
    >
      {children}
    </RadioPrimitive.Root>
  );
}
