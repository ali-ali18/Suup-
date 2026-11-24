import { ChevronDown, ChevronUp, CircleAlert } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../lib/cx.js";
import { EVENT_LINE_CLASS } from "./message.js";

/** The same line as a button (a run that ended: it opens its details in place). */
export function EventLineButton({
  children,
  className,
  type,
  ...rest
}: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type ?? "button"}
      className={cx(
        EVENT_LINE_CLASS,
        "w-full cursor-pointer border-0 bg-transparent hover:text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * A run that failed or was cancelled: one centred line. Clicking it expands the details IN PLACE
 * (the origin and what it means, the detail, a link to the inspector).
 */
export function EndedLine({
  text,
  expanded,
  onToggle,
  children,
}: {
  text: string;
  expanded: boolean;
  onToggle(): void;
  children?: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className="flex flex-col items-center gap-2" data-testid="ended-line-wrap">
      <EventLineButton
        data-testid="ended-line"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        title={text}
      >
        <CircleAlert size={13} aria-hidden="true" />
        <span className="overflow-hidden text-ellipsis">{text}</span>
        {expanded ? (
          <ChevronUp size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </EventLineButton>
      {expanded && (
        <div
          id={bodyId}
          className="flex max-w-reading flex-col items-center gap-2 text-center text-small text-text-muted"
          role="region"
          aria-label="Detalhes da execução"
          data-testid="ended-detail"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The last thing in the chat while the bot works: the bot's LIVE avatar, small, where its next
 * message will appear, and a short friendly phrase of what it is doing (from the real state of the
 * run, never flavour text). It replaced the three dots (owner, 24/11/2026). The face (`face`) is
 * drawn by whoever knows the bot (`ui/avatar.tsx`); this is only the row.
 *
 * `leaving`: the run is over and the bot's answer is there; the row fades and closes its height
 * smoothly (no jump: the grid row goes from its height to zero), and is no longer announced.
 * Reduced motion makes both instant (the durations are zero in `tokens.css`).
 */
export function WorkingIndicator({
  phrase,
  activity,
  face,
  leaving = false,
  onLeft,
}: {
  phrase: string;
  /** The declared activity (`lib/chat-activity.ts`), for tests and styles. */
  activity: string;
  face: ReactNode;
  leaving?: boolean;
  /** The leaving transition ended. */
  onLeft?(): void;
}) {
  // An activity still going on reads as one ("Pensando…"); a pause or the end does not.
  const going = !(activity === "paused" || activity === "done" || activity === "failed");
  return (
    <div
      className={cx(
        "grid transition-[grid-template-rows,opacity] duration-(--duration-leave) ease-out",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
      data-testid="working-wrap"
      data-leaving={leaving}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.propertyName === "opacity") onLeft?.();
      }}
    >
      <div className="min-h-0 animate-fade-in overflow-hidden">
        <div
          className="flex min-h-avatar-md items-center gap-3"
          {...(leaving ? { "aria-hidden": true } : { role: "status" })}
          data-testid="working-indicator"
          data-phrase={phrase}
          data-activity={activity}
        >
          {face}
          {/* "Discreet" (a setting) keeps the phrase for screen readers only. */}
          <span className="truncate text-label text-text-muted phrase-discreet:sr-only">
            {going ? `${phrase}…` : phrase}
          </span>
        </div>
      </div>
    </div>
  );
}
