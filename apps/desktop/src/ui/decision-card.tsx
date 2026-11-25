import type { ReactNode, Ref } from "react";
import { cx } from "../lib/cx.js";
import { IconBox } from "./icon-box.js";

/** The chrome every card of the chat shares (docs/DESIGN.md §3): one border, one radius. */
export const CARD_CHROME = "ui-action min-w-0 rounded-card border border-border bg-surface";

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
  compact,
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
  /**
   * The compact card (owner, 25/11/2026, the secret request): the icon beside the title, the
   * paragraph under the title, no category row; less padding.
   */
  compact?: boolean;
}) {
  return (
    <div
      ref={rootRef}
      className={cx(
        CARD_CHROME,
        compact === true ? "flex flex-col gap-3 p-4" : "flex flex-col gap-4 p-5",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      )}
      data-testid={testId}
      data-state="needs-action"
      role="group"
      aria-label={groupLabel}
      aria-busy={busy ? true : undefined}
      tabIndex={rootRef === undefined ? undefined : -1}
    >
      {compact === true ? (
        <div className="flex items-start gap-3">
          <IconBox>{icon}</IconBox>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-label font-title wrap-anywhere" data-testid="decision-title">
              {title}
            </p>
            <p
              className="text-small wrap-anywhere text-text-muted"
              data-testid={ledeTestId ?? "decision-lede"}
            >
              {lede}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <IconBox>{icon}</IconBox>
            <strong className="text-small font-title" data-testid="decision-category">
              {category}
            </strong>
            {aside !== undefined && (
              <span className="ml-auto text-small text-text-muted">{aside}</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-title font-title wrap-anywhere" data-testid="decision-title">
              {title}
            </p>
            <p className="text-label text-text-muted" data-testid={ledeTestId ?? "decision-lede"}>
              {lede}
            </p>
          </div>
        </>
      )}
      {children !== undefined && <div className="min-w-0">{children}</div>}
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-testid="decision-footer"
      >
        <div className="flex min-w-0 shrink grow basis-50 text-small text-text-muted">
          {footerNote}
        </div>
        <div className="ml-auto flex items-center gap-2">{footer}</div>
      </div>
    </div>
  );
}
