import { ChevronsDownUp, ChevronsUpDown, LoaderCircle } from "lucide-react";
import { type HTMLAttributes, type ReactNode, type Ref, useId } from "react";
import { cx } from "../lib/cx.js";
import { CARD_CHROME, DecisionCard } from "./decision-card.js";
import { IconBox } from "./icon-box.js";

/** The line of detail of an open card: small and muted ("Motivo da recusa", "Permitido por uma regra"). */
export function ActionLabel({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="m-0 text-small text-text-muted" {...rest}>
      {children}
    </p>
  );
}

/** The column of collapsed cards in the bot's side of the chat: flat, one under the other. */
export function ActionList({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="flex w-full max-w-reading flex-col gap-1" {...rest}>
      {children}
    </div>
  );
}

/** `stopped`: ended without being done and without being a failure (denied, expired, cancelled). */
export type ActionCardState = "running" | "done" | "failed" | "needs-action" | "stopped";

const STATE_LABEL: Record<Exclude<ActionCardState, "needs-action">, string> = {
  running: "Rodando",
  done: "Concluído",
  failed: "Falhou",
  stopped: "Encerrado",
};

/** The collapsed row: icon, bold kind, muted summary, and the chevron at the end. */
const ROW =
  "flex w-full min-w-0 items-center gap-3 rounded-card border-0 bg-transparent px-4 py-3 text-left";

/** The expand chevron shows only on hover and on keyboard focus (`aria-expanded` says it always). */
const CHEVRON =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100";

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
      <IconBox>{icon}</IconBox>
      <strong className="flex-none text-label font-title" data-testid="action-kind">
        {kind}
      </strong>
      <span
        className={cx(
          "min-w-0 flex-1 truncate text-label",
          state === "failed" ? "text-danger-text" : "text-text-muted",
        )}
      >
        {label === "" ? summary : `${label} · ${summary}`}
      </span>
      <span className="inline-flex min-w-icon flex-none text-text-muted" aria-hidden="true">
        {state === "running" ? (
          <LoaderCircle size={16} className="animate-spin" />
        ) : children === undefined ? null : expanded ? (
          <ChevronsDownUp size={16} className={CHEVRON} data-testid="action-chevron" />
        ) : (
          <ChevronsUpDown size={16} className={CHEVRON} data-testid="action-chevron" />
        )}
      </span>
    </>
  );
  return (
    <div
      className={cx(CARD_CHROME)}
      data-testid={testId}
      data-state={state}
      data-expanded={expanded}
    >
      {openable ? (
        <button
          type="button"
          className={cx(ROW, "group hover:bg-hover")}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          {content}
        </button>
      ) : (
        <div className={ROW}>{content}</div>
      )}
      {expanded && children !== undefined && (
        <div
          id={bodyId}
          className="flex flex-col gap-3 pt-1 pr-4 pb-4 pl-[calc(var(--space-4)+var(--size-icon-box)+var(--space-3))]"
          role="region"
          aria-label={`Detalhes: ${kind}, ${summary}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
