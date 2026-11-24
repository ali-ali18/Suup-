/*
 * Our copy of the shadcn `button` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Button. Only the base is copied: the variants of shadcn (`cva`) are
 * replaced by the typed maps of `Pill`, `RoundButton` and `IconButton` in `ui/primitives.tsx`
 * (`tone`, `size`), which draw through this `Button` and keep their props for the screens
 * (docs/DESIGN.md §2a).
 *
 * Base UI gives the button its semantics (`type="button"` unless a form asks for `submit`, Enter and
 * Space, the native `disabled`) and one more thing: while the action runs (`aria-busy`), the button
 * keeps the focus (`focusableWhenDisabled`: it is `aria-disabled` and `data-disabled` instead of
 * `disabled`, so the keyboard user is not thrown out of the card). Everywhere else `disabled` is the
 * button's own, so `:disabled` and Playwright's `toBeDisabled()` see it.
 */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { ComponentProps } from "react";

export type ButtonProps = ComponentProps<typeof ButtonPrimitive>;

/** The class that dims a button that cannot be used, native `disabled` or the busy `data-disabled`. */
export const BUTTON_DISABLED = "disabled:opacity-40 data-disabled:opacity-40";

/** A button: `aria-busy` (true) keeps the focus on it while it is disabled. */
export function Button({ className, ...rest }: ButtonProps) {
  const busy = rest["aria-busy"] === true || rest["aria-busy"] === "true";
  return <ButtonPrimitive focusableWhenDisabled={busy} className={className} {...rest} />;
}
