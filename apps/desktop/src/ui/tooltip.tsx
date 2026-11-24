/*
 * Our copy of the shadcn `tooltip` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Tooltip. Rewritten to our tokens (docs/DESIGN.md §2a): the calm raised
 * pill of the app (no arrow, no inverse fill), `shadow-popover`, and the entrance of Base UI's own
 * `data-starting-style`/`data-ending-style` (it fades and grows a little; reduced motion zeroes it).
 *
 * A tip only helps the eye ("tooltips alone are not accessible to touch or screen reader users",
 * Base UI): the name of the control stays in its `aria-label`.
 */
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/** How long the pointer rests on a control before its tip shows (ms); the next one is instant. */
export const TIP_DELAY = 500;

/** Groups the tips of the app: once one is open, moving to the next shows it at once. */
export function TipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delay={TIP_DELAY}>{children}</TooltipPrimitive.Provider>;
}

/**
 * A tip beside a control: `children` is the control itself (a button), rendered as the trigger, so
 * its role, name and handlers stay its own. `side` is where the tip goes (`top` by default).
 */
export function Tip({
  label,
  children,
  side = "top",
  delay,
  testId,
}: {
  label: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "right" | "bottom" | "left";
  /** Overrides the delay of the provider (0 for the names of the rail, which show at once). */
  delay?: number;
  testId?: string;
}) {
  return (
    <TooltipPrimitive.Root disableHoverablePopup>
      <TooltipPrimitive.Trigger render={children} {...(delay === undefined ? {} : { delay })} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          sideOffset={8}
          className="pointer-events-none z-60"
        >
          <TooltipPrimitive.Popup
            data-testid={testId}
            className="max-w-menu-wide origin-(--transform-origin) rounded-pill border border-border-strong bg-raised px-2.5 py-1 text-small text-text shadow-popover transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
