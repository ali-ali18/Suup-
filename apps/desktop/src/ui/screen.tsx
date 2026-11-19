import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { MutedText } from "./primitives.js";

/** A full-screen view of the content area (memory, pending, inspector): a head and a body. */
export function Screen({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" {...rest}>
      {children}
    </div>
  );
}

/**
 * The head of a screen: the title (and a line under it), what leads it (the back button) and what
 * ends it (the main action).
 */
export function ScreenHead({
  title,
  subtitle,
  leading,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-none items-center justify-between gap-4 px-6 pt-5 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div>
          <h1 className="text-heading font-title">{title}</h1>
          {subtitle !== undefined && (
            <MutedText as="p" className="wrap-anywhere whitespace-pre-wrap">
              {subtitle}
            </MutedText>
          )}
        </div>
      </div>
      {action}
    </header>
  );
}

/** How far the body of a screen stretches: `narrow` limits what is in it, `wide` the body itself. */
const SCREEN_LIMIT = {
  none: "",
  narrow: "*:w-full *:max-w-screen-narrow",
  wide: "max-w-screen-wide",
} as const;

/** The scrolling body of a screen: its blocks one under the other. */
export function ScreenBody({
  limit = "none",
  children,
}: {
  limit?: keyof typeof SCREEN_LIMIT;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-2 pb-6",
        SCREEN_LIMIT[limit],
      )}
    >
      {children}
    </div>
  );
}
