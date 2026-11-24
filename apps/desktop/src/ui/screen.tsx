import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { MutedText } from "./primitives.js";
import { ScrollFade } from "./scroll-fade.js";

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
 * The head of every full screen: centred in the same column as the body (`max-w-screen-max`, owner
 * 23/11/2026: nothing stretches across a 32" monitor), and with the corner of the app's own window
 * buttons kept free (`framed:pr-head-end`: nothing ever sits under them). Used by `ScreenHead` and
 * by a screen that draws its own head (a connector's page).
 */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-none px-6 pt-5 pb-3 framed:pr-head-end" data-tauri-drag-region>
      <div className="max-w-screen-max mx-auto flex w-full min-w-0 flex-col gap-4">{children}</div>
    </header>
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
    <ScreenHeader>
      <div className="flex items-center justify-between gap-4">
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
      </div>
    </ScreenHeader>
  );
}

/**
 * How far the body of a screen stretches: every body is centred and never wider than
 * `--width-screen-max`; `wide` is narrower (the inspector), `narrow` limits each block in it.
 */
const SCREEN_LIMIT = {
  none: "max-w-screen-max",
  narrow: "max-w-screen-max *:w-full *:max-w-screen-narrow",
  wide: "max-w-screen-wide",
} as const;

/** The scrolling body of a screen: its blocks one under the other, with soft edges. */
export function ScreenBody({
  limit = "none",
  children,
}: {
  limit?: keyof typeof SCREEN_LIMIT;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-2 pb-6">
        <div
          className={cx("mx-auto flex w-full flex-col gap-4", SCREEN_LIMIT[limit])}
          data-testid="screen-body"
        >
          {children}
        </div>
      </div>
      <ScrollFade />
    </div>
  );
}
