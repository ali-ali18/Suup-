/*
 * Our copy of the shadcn `input` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Input: the line of a form (a pill, one control high) and, as `Textarea`,
 * the rounded box. Rewritten to our tokens (docs/DESIGN.md §2a): our border (stronger on hover and
 * on focus, as the chat's input; no ring and never the white line), our danger colour. Inside a `Field` (`ui/field.tsx`) Base UI ties it to its label and its messages.
 */
import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Input as InputPrimitive } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

/**
 * The pieces of a form field, shared by the text field here, the secure field, the dropdown's
 * bordered variant and the rows of the settings: a screen never writes these classes again.
 */
const FIELD_CONTROL =
  "w-full min-w-0 border text-text placeholder:text-text-muted transition-[border-color] focus-visible:border-border-strong focus-visible:outline-none";

/** The control of a field: a line (a pill, one control high) or a text area (a rounded box). */
export function fieldControlClass(
  options: {
    multiline?: boolean;
    error?: boolean;
    align?: "center";
    /** `sm`: a field of a settings row (32 px, small text); `lg`: the big field of "Crie seu bot" (56 px, title text). */
    size?: "sm" | "lg";
    /** Room at the end for a button inside the field (the eye), in monospace (a secret). */
    secret?: boolean;
    /** Room at the start for the magnifier inside the field (`SearchField`). */
    search?: boolean;
    /** The colour of the chat input (`bg-raised`) instead of the page's (owner, 23/11/2026). */
    raised?: boolean;
  } = {},
): string {
  return cx(
    FIELD_CONTROL,
    options.raised === true ? "bg-raised" : "bg-bg",
    options.multiline === true
      ? cx("resize-y rounded-row", options.size === "lg" ? "px-5 py-4" : "px-4 py-2.5")
      : cx(
          "rounded-pill py-0",
          options.size === "sm" ? "h-8" : options.size === "lg" ? "h-14" : "h-control",
          options.secret === true
            ? "pr-11 pl-4 font-mono"
            : options.search === true
              ? "pr-4 pl-11"
              : options.size === "lg"
                ? "px-5"
                : "px-4",
        ),
    options.size === "sm" ? "text-small" : options.size === "lg" ? "text-title" : "text-body",
    // Hover: the field's own border gets stronger (owner, 24/11/2026); an error keeps its red.
    options.error === true
      ? "border-danger-text"
      : "border-border enabled:hover:border-border-strong",
    options.align === "center" && "text-center",
  );
}

type ControlLook = NonNullable<Parameters<typeof fieldControlClass>[0]>;

/** The single-line field (`<input>`). `look` picks the variant (size, error, secret...); `className` is only position. */
export function Input({
  look,
  className,
  onValueChange,
  ...rest
}: {
  look?: Omit<ControlLook, "multiline">;
  className?: string;
  onValueChange?(value: string): void;
} & Omit<ComponentProps<"input">, "className" | "onChange" | "size">) {
  return (
    <InputPrimitive
      className={cx(fieldControlClass(look), className)}
      {...(onValueChange === undefined
        ? {}
        : { onValueChange: (value: string) => onValueChange(value) })}
      {...rest}
    />
  );
}

/** The text area: the same control as a rounded box, tied to its `Field` like the input. */
export function Textarea({
  look,
  className,
  onValueChange,
  value,
  placeholder,
  autoFocus,
  rows,
}: {
  look?: Omit<ControlLook, "multiline">;
  className?: string;
  onValueChange(value: string): void;
  value: string;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  rows?: number;
}) {
  return (
    <FieldPrimitive.Control
      render={<textarea rows={rows} placeholder={placeholder} autoFocus={autoFocus} />}
      className={cx(fieldControlClass({ ...look, multiline: true }), className)}
      value={value}
      onValueChange={(next: string) => onValueChange(next)}
    />
  );
}
