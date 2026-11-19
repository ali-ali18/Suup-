import { X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

type PillTone = "primary" | "secondary" | "ghost" | "danger";

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: PillTone;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** The fully round action button (Figma v2/Pill): white primary with dark text, the rest neutral. */
export function Pill({ tone = "secondary", icon, children, className, type, ...rest }: PillProps) {
  return (
    <button
      type={type ?? "button"}
      className={`ui-pill ui-pill--${tone}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "raised" | "primary" | "ghost";
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
      className={`ui-round ui-round--${tone} ui-round--${size}${className ? ` ${className}` : ""}`}
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
    <section className={`ui-card ui-card--${tone}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </section>
  );
}

/** Round icon plate at the start of a card's header. */
export function IconCircle({ children }: { children: ReactNode }) {
  return (
    <span className="ui-icon-circle" aria-hidden="true">
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
    <div className="ui-card__header">
      <IconCircle>{icon}</IconCircle>
      <div className="ui-card__titles">
        <h3 className="ui-card__title">{title}</h3>
        {subtitle !== undefined && <p className="ui-card__subtitle">{subtitle}</p>}
      </div>
      {trailing}
    </div>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "outline" | "danger";
}) {
  return <span className={`ui-tag ui-tag--${tone}`}>{children}</span>;
}

export function Counter({ value, label }: { value: number; label?: string }) {
  if (value <= 0) return null;
  return (
    <span className="ui-counter" role="img" aria-label={label ?? `${value} não lidas`}>
      {value > 99 ? "99+" : value}
    </span>
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
    className: "ui-field__control",
  } as const;
  return (
    <div className={`ui-field${error !== undefined ? " ui-field--error" : ""}`}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "ui-field__label"}>
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
        <p id={`${id}-err`} className="ui-field__error" role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="ui-field__hint">
          {hint}
        </p>
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
      className={`ui-toggle${checked ? " ui-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle__knob" />
    </button>
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
    <div role="tablist" aria-label={label} className="ui-tabs">
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
          className={`ui-tab${tab.id === value ? " ui-tab--active" : ""}`}
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
      className={`ui-option${selected ? " ui-option--selected" : ""}`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="ui-option__radio" aria-hidden="true">
        {selected && <span className="ui-option__dot" />}
      </span>
      <span className="ui-option__text">
        <span className="ui-option__label">{label}</span>
        {description !== undefined && description !== "" && (
          <span className="ui-option__detail">{description}</span>
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
    <div className="ui-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ui-toast ui-toast--${t.tone}`} data-testid="toast">
          <span className="ui-toast__text">{t.text}</span>
          <button
            type="button"
            className="ui-toast__close"
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
    <div className="ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`ui-dialog${wide ? " ui-dialog--wide" : ""}`}
        onKeyDown={onKeyDown}
      >
        <div className="ui-dialog__head">
          <h2 id={titleId} className="ui-dialog__title">
            {title}
          </h2>
          <button
            type="button"
            className="ui-dialog__x"
            aria-label="Fechar janela"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="ui-dialog__body">{children}</div>
        {footer !== undefined && <div className="ui-dialog__footer">{footer}</div>}
      </div>
    </div>,
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
    <div className="ui-empty">
      {icon !== undefined && <IconCircle>{icon}</IconCircle>}
      <p className="ui-empty__title">{title}</p>
      {text !== undefined && <p className="ui-empty__text">{text}</p>}
      {action}
    </div>
  );
}
