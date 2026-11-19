import { ChevronDown, ChevronUp, CircleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";

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
    <div className="ui-ended" data-testid="ended-line-wrap">
      <button
        type="button"
        className="ui-event ui-event--button"
        data-testid="ended-line"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        title={text}
      >
        <CircleAlert size={13} aria-hidden="true" />
        <span className="ui-event__text">{text}</span>
        {expanded ? (
          <ChevronUp size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="ui-ended__body"
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

/** Three dots, the last one brightest. `animated` false (paused) leaves them still. */
export function Dots({ animated = true, size = "md" }: { animated?: boolean; size?: "md" | "lg" }) {
  return (
    <span
      className={`ui-dots ui-dots--${size}${animated ? " ui-dots--animated" : ""}`}
      aria-hidden="true"
    >
      <span className="ui-dots__dot" />
      <span className="ui-dots__dot" />
      <span className="ui-dots__dot" />
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
    <div className="ui-working" role="status" data-testid="working-indicator" data-phrase={phrase}>
      <Dots animated={animated} />
      <span className="ui-working__phrase">{phrase}</span>
    </div>
  );
}
