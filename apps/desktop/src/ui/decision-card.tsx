import type { ReactNode, Ref } from "react";

/**
 * The card of a decision that waits for you (an approval, a secret request): one bordered, rounded
 * card in the bot's column. A small header (the category icon in a rounded square, its name, and
 * something quiet on the right), a bold title with one muted paragraph, the content, and a footer
 * (a muted line on the left, the buttons on the right). It takes the focus as a group when it
 * appears. Decided, the same cards become the single collapsed row of `ActionCard`.
 */
export function DecisionCard({
  testId,
  rootRef,
  groupLabel,
  busy,
  icon,
  category,
  aside,
  title,
  lede,
  ledeTestId,
  children,
  footerNote,
  footer,
}: {
  testId: string;
  rootRef?: Ref<HTMLDivElement>;
  groupLabel: string;
  busy: boolean;
  icon: ReactNode;
  category: string;
  /** Quiet text at the right end of the header (the risk of the call). */
  aside?: ReactNode;
  title: string;
  lede: string;
  ledeTestId?: string;
  children?: ReactNode;
  /** The muted line at the left of the footer. */
  footerNote?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      className="ui-action ui-action--needs"
      data-testid={testId}
      data-state="needs-action"
      role="group"
      aria-label={groupLabel}
      aria-busy={busy ? true : undefined}
      tabIndex={rootRef === undefined ? undefined : -1}
    >
      <div className="ui-decision__head">
        <span className="ui-action__icon" aria-hidden="true">
          {icon}
        </span>
        <strong className="ui-decision__category">{category}</strong>
        {aside !== undefined && <span className="ui-decision__aside">{aside}</span>}
      </div>
      <div className="ui-decision__intro">
        <p className="ui-decision__title">{title}</p>
        <p className="ui-decision__lede" data-testid={ledeTestId}>
          {lede}
        </p>
      </div>
      {children !== undefined && <div className="ui-decision__content">{children}</div>}
      <div className="ui-decision__footer">
        <div className="ui-decision__note">{footerNote}</div>
        <div className="ui-decision__actions">{footer}</div>
      </div>
    </div>
  );
}
