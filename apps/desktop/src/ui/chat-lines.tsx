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

/** The three dots: the first two fade, the last one is the brightest. */
const DOTS = ["opacity-40 bg-text-muted", "opacity-70 bg-text-muted", "bg-text"] as const;
const DOT_DELAY = ["", "[animation-delay:0.2s]", "[animation-delay:0.4s]"] as const;

/** Three dots, the last one brightest. `animated` false (paused) leaves them still. */
export function Dots({ animated = true, size = "md" }: { animated?: boolean; size?: "md" | "lg" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center",
        size === "lg" ? "gap-1.5" : "gap-1",
        animated && "ui-dots--animated",
      )}
      aria-hidden="true"
    >
      {DOTS.map((tone, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed dots
          key={i}
          className={cx(
            "ui-dots__dot rounded-pill",
            size === "lg" ? "size-3.25" : "size-2",
            tone,
            animated && "animate-dot",
            animated && DOT_DELAY[i],
          )}
        />
      ))}
    </span>
  );
}

/**
 * The last thing in the chat while the bot works: the dots and a short muted phrase that says what
 * it is doing (from the real state of the run, never flavour text).
 */
export function WorkingIndicator({
  phrase,
  animated = true,
}: {
  phrase: string;
  animated?: boolean;
}) {
  return (
    <div
      className="flex min-h-6 items-center gap-3 px-2"
      role="status"
      data-testid="working-indicator"
      data-phrase={phrase}
    >
      <Dots animated={animated} />
      {/* "Discreet" (a setting) keeps the phrase for screen readers only. */}
      <span className="truncate text-label text-text-muted phrase-discreet:sr-only">{phrase}</span>
    </div>
  );
}
