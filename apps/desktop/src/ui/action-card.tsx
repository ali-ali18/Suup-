import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { type ReactNode, useId } from "react";

export type ActionCardState = "running" | "done" | "failed" | "needs-action";

const STATE_LABEL: Record<Exclude<ActionCardState, "needs-action">, string> = {
  running: "Rodando",
  done: "Concluído",
  failed: "Falhou",
};

/** What a card that needs the user shows: a title and instruction, a preview, and the buttons. */
export interface NeedsAction {
  title: string;
  instruction: string;
  /** Edge to edge, under the instruction (the screen of the bot's computer). */
  preview?: ReactNode;
  actions: ReactNode;
}

export interface ActionCardProps {
  icon: ReactNode;
  /** The bold word: "Terminal", "Arquivos", "Web"... */
  kind: string;
  state: ActionCardState;
  /** One line: what it did. */
  summary: string;
  expanded: boolean;
  onToggle(): void;
  /** The details, shown in place when expanded: plain text on the card's own background. */
  children?: ReactNode;
  /** For `needs-action`. */
  needsAction?: NeedsAction;
}

/**
 * An action of the bot (Figma-less: the owner's reference). One flat card in the bot's message
 * column: collapsed it is one row (icon, bold kind, muted "Concluído · summary", chevron or a
 * spinner); clicking expands it IN PLACE. No inner boxes: the details are plain text on the card.
 * The variant that needs the user shows a title, an instruction, a preview and pills.
 */
export function ActionCard({
  icon,
  kind,
  state,
  summary,
  expanded,
  onToggle,
  children,
  needsAction,
}: ActionCardProps) {
  const bodyId = useId();
  if (state === "needs-action" && needsAction !== undefined) {
    return (
      <div
        className="ui-action ui-action--needs"
        data-testid="action-card"
        data-state="needs-action"
      >
        <div className="ui-action__row ui-action__row--static">
          <span className="ui-action__icon" aria-hidden="true">
            {icon}
          </span>
          <strong className="ui-action__kind">{kind}</strong>
        </div>
        <div className="ui-action__needs">
          <p className="ui-action__needs-title">{needsAction.title}</p>
          <p className="ui-action__needs-text">{needsAction.instruction}</p>
        </div>
        {needsAction.preview !== undefined && (
          <div className="ui-action__preview">{needsAction.preview}</div>
        )}
        <div className="ui-action__actions">{needsAction.actions}</div>
      </div>
    );
  }
  const label = STATE_LABEL[state === "needs-action" ? "done" : state];
  return (
    <div
      className={`ui-action ui-action--${state}`}
      data-testid="action-card"
      data-state={state}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="ui-action__row"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="ui-action__icon" aria-hidden="true">
          {icon}
        </span>
        <strong className="ui-action__kind">{kind}</strong>
        <span className="ui-action__summary">
          {label} · {summary}
        </span>
        <span className="ui-action__end" aria-hidden="true">
          {state === "running" ? (
            <LoaderCircle size={16} className="ui-spin" />
          ) : expanded ? (
            <ChevronUp size={16} />
          ) : (
            <ChevronDown size={16} />
          )}
        </span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="ui-action__body"
          role="region"
          aria-label={`Detalhes: ${kind}, ${summary}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The row that stands for older finished cards: "Mais N ações". Expands in place to show them. */
export function ActionFold({
  count,
  expanded,
  onToggle,
  children,
}: {
  count: number;
  expanded: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className="ui-action ui-action--fold" data-testid="action-fold" data-expanded={expanded}>
      <button
        type="button"
        className="ui-action__row"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <strong className="ui-action__kind">Mais {count} ações</strong>
        <span className="ui-action__summary">Concluídas</span>
        <span className="ui-action__end" aria-hidden="true">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="ui-action__fold-body"
          role="region"
          aria-label={`${count} ações anteriores`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
