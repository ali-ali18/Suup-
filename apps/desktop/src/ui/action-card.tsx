import { ChevronsDownUp, ChevronsUpDown, LoaderCircle } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";
import { DecisionCard } from "./decision-card.js";

/** `stopped`: ended without being done and without being a failure (denied, expired, cancelled). */
export type ActionCardState = "running" | "done" | "failed" | "needs-action" | "stopped";

const STATE_LABEL: Record<Exclude<ActionCardState, "needs-action">, string> = {
  running: "Rodando",
  done: "Concluído",
  failed: "Falhou",
  stopped: "Encerrado",
};

/** What a card that needs the user shows: a title and instruction, a preview, and the buttons. */
export interface NeedsAction {
  title: string;
  instruction: string;
  /** The content, under the instruction (the screen of the bot's computer). */
  preview?: ReactNode;
  /** Quiet text at the right end of the header. */
  header?: ReactNode;
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
  /** The word before the summary (default: by state). Empty: the summary stands alone. */
  stateLabel?: string;
  /** Default `action-card`: other kinds of card name themselves. */
  testId?: string;
  /** For `needs-action`: the card as a named group, which can take the focus when it appears. */
  rootRef?: Ref<HTMLDivElement>;
  groupLabel?: string;
  busy?: boolean;
  /** For `needs-action`. */
  needsAction?: NeedsAction;
}

/**
 * The collapsed card, shared by every card that is over: a tool action, a decided approval, an
 * answered secret request. One bordered row: the icon in a small rounded square, the bold category,
 * the muted result. The chevron appears only on hover and on keyboard focus (always announced by
 * `aria-expanded`); clicking opens the details in place, and again closes them. A card with no
 * details is the same row, with nothing to open.
 */
export function ActionCard({
  icon,
  kind,
  state,
  summary,
  expanded,
  onToggle,
  children,
  stateLabel,
  testId = "action-card",
  rootRef,
  groupLabel,
  busy,
  needsAction,
}: ActionCardProps) {
  const bodyId = useId();
  if (state === "needs-action" && needsAction !== undefined) {
    return (
      <DecisionCard
        testId={testId}
        {...(rootRef === undefined ? {} : { rootRef })}
        groupLabel={groupLabel ?? `${kind}: ${needsAction.title}`}
        busy={busy === true}
        icon={icon}
        category={kind}
        aside={needsAction.header}
        title={needsAction.title}
        lede={needsAction.instruction}
        footer={needsAction.actions}
      >
        {needsAction.preview}
      </DecisionCard>
    );
  }
  const label = stateLabel ?? STATE_LABEL[state === "needs-action" ? "done" : state];
  const openable = children !== undefined;
  const content = (
    <>
      <span className="ui-action__icon" aria-hidden="true">
        {icon}
      </span>
      <strong className="ui-action__kind">{kind}</strong>
      <span className="ui-action__summary">{label === "" ? summary : `${label} · ${summary}`}</span>
      <span className="ui-action__end" aria-hidden="true">
        {state === "running" ? (
          <LoaderCircle size={16} className="ui-spin" />
        ) : children === undefined ? null : expanded ? (
          <ChevronsDownUp size={16} className="ui-action__chevron" />
        ) : (
          <ChevronsUpDown size={16} className="ui-action__chevron" />
        )}
      </span>
    </>
  );
  return (
    <div
      className={`ui-action ui-action--${state}`}
      data-testid={testId}
      data-state={state}
      data-expanded={expanded}
    >
      {openable ? (
        <button
          type="button"
          className="ui-action__row"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          {content}
        </button>
      ) : (
        <div className="ui-action__row ui-action__row--static">{content}</div>
      )}
      {expanded && children !== undefined && (
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
          {expanded ? (
            <ChevronsDownUp size={16} className="ui-action__chevron" />
          ) : (
            <ChevronsUpDown size={16} className="ui-action__chevron" />
          )}
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
