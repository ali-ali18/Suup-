import type { LucideIcon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Avatar } from "./avatar.js";
import { IconCircle, MutedText } from "./primitives.js";

/**
 * The frame of the screens before the app opens (first-run choice, connect, the embedded server's
 * start): one calm card in the middle of the window, the mascot, a title and one line under it
 * (docs/DESIGN.md §3d). With `onSubmit` the card is a form.
 */
export function WelcomeCard({
  title,
  subtitle,
  onSubmit,
  testId,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  onSubmit?(): void;
  testId?: string;
  children: ReactNode;
}) {
  const head = (
    <div className="flex flex-col items-center gap-2 text-center">
      <Avatar avatar="mascot:blob" seed="suup" size="lg" />
      <h1 className="text-heading font-bold">{title}</h1>
      {subtitle !== undefined && <MutedText as="p">{subtitle}</MutedText>}
    </div>
  );
  const card = "flex w-connect flex-col gap-4 rounded-card border border-border bg-surface p-8";
  return (
    <main className="flex min-h-full items-center justify-center overflow-auto p-6">
      {onSubmit === undefined ? (
        <div className={card} data-testid={testId}>
          {head}
          {children}
        </div>
      ) : (
        <form
          className={card}
          data-testid={testId}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {head}
          {children}
        </form>
      )}
    </main>
  );
}

/**
 * A choice that is a whole card (the first-run screen): an icon plate, a title and what it means in
 * one faded line. It is a button, so the keyboard and the screen reader get it as one.
 */
export function ChoiceCard({
  icon: Icon,
  title,
  description,
  onSelect,
  disabled,
  testId,
  recommended,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onSelect(): void;
  disabled?: boolean;
  testId?: string;
  /** Draws the stronger border: the choice the app suggests. */
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      className={cx(
        "flex w-full items-center gap-3 rounded-row border bg-bg px-4 py-3 text-left transition-colors enabled:hover:bg-hover disabled:opacity-40",
        recommended === true ? "border-border-strong" : "border-border",
      )}
      onClick={onSelect}
    >
      <IconCircle>
        <Icon size={18} />
      </IconCircle>
      <span className="flex min-w-0 flex-col leading-label">
        <span className="text-label font-label wrap-anywhere">{title}</span>
        <span className="text-small wrap-anywhere text-text-muted">{description}</span>
      </span>
    </button>
  );
}
