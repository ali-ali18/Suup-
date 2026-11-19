import { X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type LabelHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx.js";

/**
 * `primary` is the white pill, `secondary` and `danger` the neutral ones with a border, `ghost` plain
 * text that gets a background on hover, and `quiet` a ghost whose text is muted until hover.
 */
const PILL_TONE = {
  primary: "border-transparent bg-bg-inverse text-text-inverse enabled:hover:opacity-88",
  secondary: "border-border bg-raised text-text enabled:hover:bg-hover",
  danger: "border-border bg-raised text-danger-text enabled:hover:bg-hover",
  ghost: "border-transparent bg-transparent text-text enabled:hover:bg-hover",
  quiet:
    "border-transparent bg-transparent text-text-muted enabled:hover:bg-hover enabled:hover:text-text",
  /** The arrow half of the split button: the white of `primary`, a little dimmer. */
  split: "border-transparent bg-bg-inverse-dim text-text-inverse enabled:hover:opacity-88",
} as const;

/** `sm` is the pill of a row of settings (32 px), `md` the normal one (the control height). */
const PILL_SIZE = {
  md: "h-control px-4.5",
  sm: "h-8 px-4",
  /** A square pill with only an icon in it (the arrow of the split button). */
  icon: "size-control px-0",
} as const;

/** A pill joined to another (the split button): the corners on the joined side are square. */
const PILL_ATTACH = { start: "rounded-r-none", end: "rounded-l-none" } as const;

export type PillTone = keyof typeof PILL_TONE;

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: PillTone;
  size?: keyof typeof PILL_SIZE;
  /** `start`: this pill is the left half of a pair; `end`: the right half. */
  attach?: keyof typeof PILL_ATTACH;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** The fully round action button (Figma v2/Pill): white primary with dark text, the rest neutral. */
export function Pill({
  tone = "secondary",
  size = "md",
  attach,
  icon,
  children,
  className,
  type,
  ...rest
}: PillProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-pill border text-label font-label whitespace-nowrap transition-[background-color,opacity] disabled:opacity-40",
        PILL_SIZE[size],
        PILL_TONE[tone],
        attach !== undefined && PILL_ATTACH[attach],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

const ROUND_TONE = {
  raised: "border-border bg-raised text-text enabled:hover:bg-hover",
  primary: "border-transparent bg-bg-inverse text-text-inverse",
  /** The send button of the composer: the bot's colour (the neutral bubble setting turns it off). */
  bot: "border-transparent bg-bot-fill text-bot-on-fill bubble-neutral:bg-bg-inverse bubble-neutral:text-text-inverse",
  ghost: "border-transparent bg-transparent text-text enabled:hover:bg-hover",
} as const;

const ROUND_SIZE = { md: "size-control", sm: "size-8" } as const;

export interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof ROUND_TONE;
  /** Buttons without text need a name for screen readers. */
  label: string;
  size?: "md" | "sm";
  ref?: Ref<HTMLButtonElement>;
}

/** The round icon button (Figma v2/Botão redondo). */
export function RoundButton({
  tone = "raised",
  label,
  size = "md",
  className,
  type,
  children,
  ...rest
}: RoundButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-pill border disabled:opacity-40",
        ROUND_SIZE[size],
        ROUND_TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
  tone = "surface",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  tone?: "surface" | "plain";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cx(
        "flex min-w-0 flex-col gap-4 rounded-card border border-border p-5",
        tone === "surface" ? "bg-surface" : "bg-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

/** Round icon plate at the start of a card's header. */
export function IconCircle({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex size-icon-circle flex-none items-center justify-center rounded-pill border border-border bg-raised text-text"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

export function CardHeader({
  icon,
  title,
  subtitle,
  trailing,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <IconCircle>{icon}</IconCircle>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="text-title font-title wrap-anywhere">{title}</h3>
        {subtitle !== undefined && <p className="text-small text-text-muted">{subtitle}</p>}
      </div>
      {trailing}
    </div>
  );
}

const TAG_TONE = {
  neutral: "bg-raised text-text",
  outline: "border border-border-strong text-text-muted",
  danger: "",
} as const;

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof TAG_TONE;
}) {
  return (
    <span
      className={cx(
        "ui-tag inline-flex h-5.5 items-center rounded-pill px-2.5 text-section font-label whitespace-nowrap",
        TAG_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Counter({ value, label }: { value: number; label?: string }) {
  if (value <= 0) return null;
  return (
    <span
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-bg-inverse px-1.5 text-section leading-inherit font-label text-text-inverse"
      role="img"
      aria-label={label ?? `${value} não lidas`}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

/**
 * The pieces of a form field, shared by the text field here, the secure field, the dropdown's
 * bordered variant and the rows of the settings: a screen never writes these classes again.
 */
const FIELD_CONTROL =
  "w-full min-w-0 border bg-bg text-text placeholder:text-text-muted focus-visible:border-border-strong focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-0";

/** The control of a field: a line (a pill, one control high) or a text area (a rounded box). */
export function fieldControlClass(
  options: {
    multiline?: boolean;
    error?: boolean;
    align?: "center";
    /** `sm`: a field of a settings row (32 px, small text). */
    size?: "sm";
    /** Room at the end for a button inside the field (the eye), in monospace (a secret). */
    secret?: boolean;
  } = {},
): string {
  return cx(
    FIELD_CONTROL,
    options.multiline === true
      ? "resize-y rounded-row px-4 py-2.5"
      : cx(
          "rounded-pill py-0",
          options.size === "sm" ? "h-8" : "h-control",
          options.secret === true ? "pr-11 pl-4 font-mono" : "px-4",
        ),
    options.size === "sm" ? "text-small" : "text-body",
    options.error === true ? "border-danger-text" : "border-border",
    options.align === "center" && "text-center",
  );
}

/**
 * The label of a field (or of a group of them): small and muted. It is a `label` by default; `as`
 * names the element when the caption belongs to something that is not one control (a legend, a
 * heading, the caption of a dropdown).
 */
export function FieldLabel({
  children,
  as: Element = "label",
  className,
  ...rest
}: {
  children: ReactNode;
  as?: "label" | "span" | "legend" | "h3";
} & LabelHTMLAttributes<HTMLElement>) {
  return (
    <Element className={cx("text-small text-text-muted", className)} {...rest}>
      {children}
    </Element>
  );
}

/** The error of a field or of a form: said in words, in the danger colour. */
export function FieldError({
  as: Element = "p",
  alert = true,
  children,
  className,
  ...rest
}: {
  as?: "p" | "span";
  /** `false` for a line that only colours a counter: it is not announced as an alert. */
  alert?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      {...(alert ? { role: "alert" } : {})}
      className={cx("text-small leading-inherit text-danger-text", className)}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** One quiet line under a field. */
export function FieldHint({
  as: Element = "p",
  children,
  ...rest
}: { as?: "p" | "span"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element className="text-small leading-inherit text-text-muted" {...rest}>
      {children}
    </Element>
  );
}

/** A calm notice (`role` is the caller's: status, note or alert): a bordered box, no alert colour. */
export function Notice({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <div
      className={cx(
        "flex flex-col gap-1 rounded-inner border border-border-strong bg-raised px-4 py-3 text-small wrap-anywhere",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A list with bullets, one item under the other. */
export function BulletList({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5" {...rest}>
      {children}
    </ul>
  );
}

/** A form: its fields one under the other. */
export function FormStack({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <div className="flex flex-col gap-4" {...rest}>
      {children}
    </div>
  );
}

/** One row of a form: a label (a `FieldLabel`) and its control. `as="fieldset"` for a group. */
export function FormRow({
  as: Element = "div",
  children,
  className,
  ...rest
}: { as?: "div" | "fieldset"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(
        "flex flex-col gap-1.5",
        Element === "fieldset" && "m-0 min-w-0 border-0 p-0",
        className,
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** A small round icon button with no box until hover (the remove of a list, the eye of a field). */
export function IconButton({
  label,
  className,
  type,
  children,
  ...rest
}: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      className={cx(
        "inline-flex size-8 flex-none items-center justify-center rounded-pill border-0 bg-transparent text-text-muted enabled:hover:bg-hover enabled:hover:text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  error?: string | undefined;
  multiline?: boolean;
  rows?: number;
  type?: "text" | "password" | "url" | "search";
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: string;
  name?: string;
  onEnter?(): void;
  hideLabel?: boolean;
  align?: "center";
}

/** Text field (Figma v2/Campo): single or multiline, with focus and error states. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  error,
  multiline = false,
  rows = 4,
  type = "text",
  disabled,
  autoFocus,
  hint,
  name,
  onEnter,
  hideLabel,
  align,
}: TextFieldProps) {
  const id = useId();
  const describedBy =
    error !== undefined ? `${id}-err` : hint !== undefined ? `${id}-hint` : undefined;
  const common = {
    id,
    name,
    value,
    placeholder,
    disabled,
    autoFocus,
    "aria-invalid": error !== undefined ? true : undefined,
    "aria-describedby": describedBy,
    className: fieldControlClass({
      multiline,
      error: error !== undefined,
      ...(align === undefined ? {} : { align }),
    }),
  } as const;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? "sr-only" : "text-small text-text-muted"}>
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          {...common}
          type={type}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter !== undefined) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
      )}
      {error !== undefined ? (
        <FieldError id={`${id}-err`}>{error}</FieldError>
      ) : hint !== undefined ? (
        <FieldHint id={`${id}-hint`}>{hint}</FieldHint>
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cx(
        "relative h-6 w-10 flex-none rounded-pill border border-border-strong p-0",
        checked ? "bg-bg-inverse" : "bg-raised",
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-4.5 rounded-pill transition-transform",
          checked ? "translate-x-4 bg-text-inverse" : "bg-text-muted",
        )}
      />
    </button>
  );
}

/** The class of a tab (and of the filter buttons that look like one). */
export function tabClass(active: boolean): string {
  return cx(
    "h-8 rounded-pill border px-3.5 text-label font-label whitespace-nowrap hover:bg-hover",
    active
      ? "border-border bg-raised text-text"
      : "border-transparent bg-transparent text-text-muted",
  );
}

/** The small uppercase label of a group ("Hoje", "Camada"). */
export function SectionLabel({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="text-section font-label tracking-section text-text-muted uppercase" {...rest}>
      {children}
    </p>
  );
}

/** Small muted text: a subtitle, a date, a count. `as="p"` for a paragraph of it. */
export function MutedText({
  as: Element = "span",
  children,
  className,
  ...rest
}: { as?: "span" | "p"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element className={cx("text-small text-text-muted", className)} {...rest}>
      {children}
    </Element>
  );
}

/** A paragraph of text that is not ours (a rule, a name, a value): breaks anywhere, keeps its lines. */
export function PlainText({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cx("wrap-anywhere whitespace-pre-wrap", className)} {...rest}>
      {children}
    </p>
  );
}

export interface TabItem {
  id: string;
  label: string;
}

/** Tabs (Figma v2/Aba) with the arrow-key behaviour of the ARIA tabs pattern. */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  idPrefix = "tab",
}: {
  tabs: readonly TabItem[];
  value: string;
  onChange(id: string): void;
  label: string;
  idPrefix?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    onChange(target.id);
    refs.current[target.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex [scrollbar-width:none] gap-1 overflow-x-auto"
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-${tab.id}`}
          aria-selected={tab.id === value}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          className={tabClass(tab.id === value)}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export interface OptionProps {
  label: string;
  description?: string | undefined;
  selected: boolean;
  onSelect(): void;
  disabled?: boolean | undefined;
  ref?: Ref<HTMLButtonElement>;
  tabIndex?: number;
  onKeyDown?(e: KeyboardEvent): void;
}

/** A choice of a question (Figma v2/Opção): radio at the start, label and detail. */
export function Option({
  label,
  description,
  selected,
  onSelect,
  disabled,
  ref,
  tabIndex,
  onKeyDown,
}: OptionProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      tabIndex={tabIndex ?? (selected ? 0 : -1)}
      className={cx(
        "flex w-full items-center gap-3 rounded-row text-left enabled:hover:bg-hover",
        selected
          ? "px-3.875 py-2.875 border-[1.5px] border-text bg-raised"
          : "border border-border bg-bg px-4 py-3",
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span
        className={cx(
          "inline-flex size-4.5 flex-none items-center justify-center rounded-pill border-[1.5px]",
          selected ? "border-text" : "border-border-strong",
        )}
        aria-hidden="true"
      >
        {selected && <span className="size-2 rounded-pill bg-text" />}
      </span>
      <span className="flex min-w-0 flex-col leading-label">
        <span className="text-label font-label wrap-anywhere">{label}</span>
        {description !== undefined && description !== "" && (
          <span className="text-small wrap-anywhere text-text-muted">{description}</span>
        )}
      </span>
    </button>
  );
}

export interface ToastItem {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastItem[];
  onDismiss(id: number): void;
}) {
  useEffect(() => {
    const timers = toasts.map((t) =>
      setTimeout(() => onDismiss(t.id), t.tone === "error" ? 9000 : 5000),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, onDismiss]);
  return (
    <div
      className="fixed right-5 bottom-5 z-50 flex max-w-toast flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "flex items-start gap-3 rounded-row border border-border-strong bg-raised px-4 py-3 text-label shadow-popover",
            t.tone === "error" && "text-danger-text",
          )}
          data-testid="toast"
        >
          <span className="flex-1 wrap-anywhere">{t.text}</span>
          <button
            type="button"
            className="border-0 bg-transparent text-title leading-none text-text-muted"
            aria-label="Fechar aviso"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A modal with a focus trap, closed by Escape. */
const FOCUSABLE = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * What every modal surface does about the focus: it takes it when it opens, keeps Tab inside, closes
 * on Escape and gives the focus back to whatever had it. Returns the ref for the dialog element and
 * its key handler.
 */
export function useModalFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.hasAttribute("disabled"),
    )[0];
    (first ?? ref.current)?.focus();
    // When the focus is lost (what had it was removed: a row deleted from a dialog opened on top
    // of this one), the keys still reach the topmost modal: Escape closes it, Tab brings the focus back.
    const lost = (e: globalThis.KeyboardEvent) => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.item(modals.length - 1) !== ref.current) return;
      if (e.key === "Escape") closing.current();
      else if (e.key === "Tab") {
        e.preventDefault();
        (first ?? ref.current)?.focus();
      }
    };
    document.addEventListener("keydown", lost);
    return () => {
      document.removeEventListener("keydown", lost);
      if (previous?.isConnected === true) previous.focus();
      else {
        // What had the focus is gone: hand it to the modal that is now on top, if there is one.
        const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
        modals.item(modals.length - 1)?.focus();
      }
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    // A dialog opened from this one (a portal) bubbles its keys through React: those are not ours.
    if (!ref.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return { ref, onKeyDown };
}

/**
 * The dark layer behind a modal; a press on it (not on what is inside) closes the modal. `top`
 * puts the modal near the top of the window (the command palette).
 */
export function Scrim({
  onClose,
  top,
  children,
}: {
  onClose(): void;
  top?: boolean;
  children: ReactNode;
}) {
  return (
    // `ui-scrim` is a hook for the screens that must not lay out a scrim (features.css), not a style.
    <div
      className={cx(
        "ui-scrim fixed inset-0 z-40 flex justify-center bg-scrim p-5",
        top === true ? "items-start pt-[12vh]" : "items-center",
      )}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {children}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { ref, onKeyDown } = useModalFocus(onClose);
  const titleId = useId();
  // In the body, not inside whatever opened it: a dialog opened from another dialog (a rule from the
  // settings) is its own modal surface, the topmost one, with its own focus trap.
  return createPortal(
    <Scrim onClose={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "flex max-h-[90vh] flex-col gap-4 overflow-hidden rounded-card border border-border-strong bg-surface p-6 shadow-popover",
          wide ? "w-dialog-wide" : "w-dialog",
        )}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-title font-title">
            {title}
          </h2>
          <IconButton label="Fechar janela" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </IconButton>
        </div>
        {/* A tall form scrolls inside the dialog; the title and the buttons stay where they are. */}
        <div className="-m-0.5 min-h-0 flex-auto overflow-y-auto p-0.5">{children}</div>
        {footer !== undefined && <div className="flex flex-none justify-end gap-2">{footer}</div>}
      </div>
    </Scrim>,
    document.body,
  );
}

/** A honest empty state: says what will appear here, nothing is faked. */
export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
      {icon !== undefined && <IconCircle>{icon}</IconCircle>}
      <p className="text-label leading-inherit font-label">{title}</p>
      {text !== undefined && <p className="max-w-empty-text text-small text-text-muted">{text}</p>}
      {action}
    </div>
  );
}
