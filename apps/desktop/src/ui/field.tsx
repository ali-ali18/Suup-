/*
 * Our copy of the shadcn `field` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Field: `Field` (the root), `FieldCaption` (the label), `FieldDescription`
 * and `FieldMessage` (the error). Rewritten to our tokens (docs/DESIGN.md §2a). Base UI ties the label
 * to the control (`htmlFor`/`id`), the description and the error to it (`aria-describedby`).
 *
 * The invalid state comes from the screen (`invalid`, the owner's decision of 24/11/2026), never from
 * Base UI's own validation: the screen already knows what is wrong and says it in words.
 *
 * The standalone `FieldLabel`, `FieldError` and `FieldHint` are the same three lines for the places
 * that are not one control with a label (a legend, a heading, the error of a whole form).
 */
import { Field as FieldPrimitive } from "@base-ui/react/field";
import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";

const CAPTION = "text-small text-text-muted";
const ERROR = "text-small leading-inherit text-danger-text";
const HINT = "text-small leading-inherit text-text-muted";

/** One field: its label, its control, and under them the hint or the error. */
export function Field({
  invalid,
  disabled,
  name,
  className,
  children,
}: {
  /** The screen says the value is wrong (`aria-invalid` on the control). */
  invalid?: boolean;
  disabled?: boolean | undefined;
  name?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <FieldPrimitive.Root
      invalid={invalid === true}
      {...(disabled === undefined ? {} : { disabled })}
      {...(name === undefined ? {} : { name })}
      className={cx("flex flex-col gap-1.5", className)}
    >
      {children}
    </FieldPrimitive.Root>
  );
}

/** The label of the control of a `Field`; `hidden` keeps it only for the screen reader. */
export function FieldCaption({
  hidden,
  children,
}: {
  hidden?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <FieldPrimitive.Label className={hidden === true ? "sr-only" : CAPTION}>
      {children}
    </FieldPrimitive.Label>
  );
}

/** One quiet line under the control of a `Field`. */
export function FieldDescription({ children }: { children: ReactNode }) {
  return (
    <FieldPrimitive.Description render={<p />} className={HINT}>
      {children}
    </FieldPrimitive.Description>
  );
}

/** The error of the control of a `Field`: said in words, announced as an alert. */
export function FieldMessage({ children }: { children: ReactNode }) {
  return (
    <FieldPrimitive.Error match render={<p role="alert" />} className={ERROR}>
      {children}
    </FieldPrimitive.Error>
  );
}

/**
 * The label of a field (or of a group of them): small and muted. It is a `label` by default; `as`
 * names the element when the caption belongs to something that is not one control (a legend, a
 * heading, the caption of a dropdown).
 */
export function FieldLabel({
  children,
  as: Element = "label",
  className,
  ...rest
}: {
  children: ReactNode;
  as?: "label" | "span" | "legend" | "h3";
} & LabelHTMLAttributes<HTMLElement>) {
  return (
    <Element className={cx(CAPTION, Element === "h3" && "font-bold", className)} {...rest}>
      {children}
    </Element>
  );
}

/** The error of a field or of a form: said in words, in the danger colour. */
export function FieldError({
  as: Element = "p",
  alert = true,
  children,
  className,
  ...rest
}: {
  as?: "p" | "span";
  /** `false` for a line that only colours a counter: it is not announced as an alert. */
  alert?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element {...(alert ? { role: "alert" } : {})} className={cx(ERROR, className)} {...rest}>
      {children}
    </Element>
  );
}

/** One quiet line under a field. */
export function FieldHint({
  as: Element = "p",
  children,
  ...rest
}: { as?: "p" | "span"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element className={HINT} {...rest}>
      {children}
    </Element>
  );
}
