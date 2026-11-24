/*
 * Our copy of the shadcn `popover` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Popover. Rewritten to our tokens (docs/DESIGN.md §2a). The surface is
 * shared by every popup of the app (menus, the lists of a dropdown, a popover): the raised
 * background, the strong 1 px border, `shadow-popover` (never the heavy shadow nor the blur of the original), the card radius
 * with the inner padding that rounds an item inside it (maia: popup radius = item radius + padding).
 */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/cx.js";

/** The surface of every popup: a menu, the list of a dropdown, a popover. */
export const POPUP_SURFACE =
  "rounded-card border border-border-strong bg-raised text-text shadow-popover outline-none";

/**
 * How a popup comes and goes: it fades and grows a little from where it opens (Base UI's
 * `data-starting-style`/`data-ending-style`), never pops (docs/DESIGN.md §1 "Nada seco").
 */
export const POPUP_MOTION =
  "origin-(--transform-origin) transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0";

/** The layer of the popups: above a modal dialog (`z-40`) and its scrim. */
export const POPUP_LAYER = "z-60";

/**
 * A small panel that opens from a control and holds its own content (a popover, not a menu: what
 * is inside is not a list of commands). `trigger` is the control (a button). Escape and a press
 * outside close it and the focus goes back to the trigger.
 */
export function Popover({
  trigger,
  title,
  children,
  side = "bottom",
  align = "center",
  testId,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  /** The heading of the panel (it names the popup for assistive technology). */
  title: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  testId?: string;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger render={trigger} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={6}
          className={POPUP_LAYER}
        >
          <PopoverPrimitive.Popup
            data-testid={testId}
            className={cx(
              "flex w-menu-wide max-w-dropdown flex-col gap-1.5 p-4",
              POPUP_SURFACE,
              POPUP_MOTION,
            )}
          >
            <PopoverPrimitive.Title className="text-label font-label">
              {title}
            </PopoverPrimitive.Title>
            <div className="text-small text-text-muted">{children}</div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
