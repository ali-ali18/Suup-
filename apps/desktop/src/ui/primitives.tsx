import { Search } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from "react";
import { cx } from "../lib/cx.js";
import { BUTTON_DISABLED, Button } from "./button.js";
import { Field, FieldCaption, FieldDescription, FieldMessage } from "./field.js";
import { Input, Textarea } from "./input.js";
import { Tip } from "./tooltip.js";

/** The pieces of a form field live in their own files (the base-maia copies on Base UI); screens import them from here. */
export { FieldError, FieldHint, FieldLabel } from "./field.js";
export { fieldControlClass } from "./input.js";

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
  /** The one big action of a whole screen (the "Continuar" of the connectors' gallery). */
  lg: "h-12 px-8",
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
    <Button
      type={type ?? "button"}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-pill border text-label font-label whitespace-nowrap transition-[background-color,opacity]",
        BUTTON_DISABLED,
        PILL_SIZE[size],
        PILL_TONE[tone],
        attach !== undefined && PILL_ATTACH[attach],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </Button>
  );
}

const ROUND_TONE = {
  raised: "border-border bg-raised text-text enabled:hover:bg-hover",
  primary: "border-transparent bg-bg-inverse text-text-inverse",
  /** The send button of the composer: the bot's colour (the neutral bubble setting turns it off). */
  bot: "border-transparent bg-bot-fill text-bot-on-fill bubble-neutral:bg-bg-inverse bubble-neutral:text-text-inverse",
  ghost: "border-transparent bg-transparent text-text enabled:hover:bg-hover",
  /** The project's outline button: a thin ring, no fill (the panel's close, as in the Grok Bot). */
  outline: "border-border-strong bg-transparent text-text enabled:hover:bg-hover",
} as const;

const ROUND_SIZE = {
  md: "size-control",
  circle: "size-icon-circle",
  sm: "size-8",
  /** 28 px: beside the window's own buttons, centred on their 32 px strip. */
  xs: "size-7",
} as const;

export interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof ROUND_TONE;
  /** Buttons without text need a name for screen readers. */
  label: string;
  size?: keyof typeof ROUND_SIZE;
  ref?: Ref<HTMLButtonElement>;
}

/** The round icon button (Figma v2/Botão redondo). Its name shows as a tip on hover (`ui/tooltip.tsx`). */
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
    <Tip label={label}>
      <Button
        type={type ?? "button"}
        aria-label={label}
        className={cx(
          "inline-flex flex-none items-center justify-center rounded-pill border",
          BUTTON_DISABLED,
          ROUND_SIZE[size],
          ROUND_TONE[tone],
          className,
        )}
        {...rest}
      >
        {children}
      </Button>
    </Tip>
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
        "inline-flex h-5.5 items-center rounded-pill px-2.5 text-section font-label whitespace-nowrap",
        TAG_TONE[tone],
      )}
      data-testid="tag"
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
    <Button
      type={type ?? "button"}
      aria-label={label}
      className={cx(
        "inline-flex size-8 flex-none items-center justify-center rounded-pill border-0 bg-transparent text-text-muted enabled:hover:bg-hover enabled:hover:text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </Button>
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
  /** The browser's hint for filling the field (`nickname`, ...). */
  autoComplete?: string;
  /** What the Enter key of a touch keyboard says (`done`, ...). */
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  maxLength?: number;
  /** The colour of the chat's input (`bg-raised`) instead of the page's (the welcome). */
  raised?: boolean;
  /** `lg`: the big field of "Crie seu bot" (taller, title-sized text). */
  size?: "lg";
}

/** Text field (Figma v2/Campo): single or multiline, with focus and error states, on `Field` and `Input`. */
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
  autoComplete,
  enterKeyHint,
  maxLength,
  raised = false,
  size,
}: TextFieldProps) {
  const look = {
    error: error !== undefined,
    raised,
    ...(size === undefined ? {} : { size }),
    ...(align === undefined ? {} : { align }),
  } as const;
  return (
    <Field invalid={error !== undefined} disabled={disabled} name={name}>
      <FieldCaption hidden={hideLabel}>{label}</FieldCaption>
      {multiline ? (
        <Textarea
          look={look}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={rows}
          onValueChange={onChange}
        />
      ) : (
        <Input
          look={look}
          type={type}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          {...(enterKeyHint === undefined ? {} : { enterKeyHint })}
          {...(maxLength === undefined ? {} : { maxLength })}
          onValueChange={onChange}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter !== undefined) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
      )}
      {error !== undefined ? (
        <FieldMessage>{error}</FieldMessage>
      ) : hint !== undefined ? (
        <FieldDescription>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * The search field as an input group (owner, 23/11/2026: "um input group onde tem a lupa dentro
 * dele"), in the colour of the chat input: the magnifier is INSIDE the field, at the start, and the
 * text begins after it. The label is
 * only for the screen reader. Its width is the caller's (`max-w-search`, the token of a screen's
 * search).
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  className,
  testId,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  className?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className={cx("relative", className)} data-testid={testId}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        size={16}
        className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        look={{ search: true, raised: true }}
        onValueChange={onChange}
      />
    </div>
  );
}

/** The on/off switch lives in its own file (the base-maia copy on Base UI); screens import it from here. */
export { Toggle } from "./switch.js";

/** The class of a tab (and of the filter buttons that look like one). */
export function tabClass(active: boolean): string {
  return cx(
    "h-8 rounded-pill border px-3.5 text-label font-label whitespace-nowrap hover:bg-hover",
    active
      ? "border-border bg-raised text-text"
      : "border-transparent bg-transparent text-text-muted",
  );
}

/** The small uppercase label of a group ("Hoje", "Camada"). `as="h2"` when it heads a section. */
export function SectionLabel({
  as: Element = "p",
  children,
  className,
  ...rest
}: { as?: "p" | "h2"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(
        "text-section font-label tracking-section text-text-muted uppercase",
        className,
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}

/**
 * Muted text: a subtitle, a date, a count (small, by default). `as="p"` for a paragraph of it.
 * `size="inherit"` keeps the size of the text around it (the description after a bot's name).
 */
export function MutedText({
  as: Element = "span",
  size = "small",
  children,
  className,
  ...rest
}: {
  as?: "span" | "p";
  size?: "small" | "inherit";
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(size === "small" && "text-small", "text-text-muted", className)}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** A paragraph of text that is not ours (a rule, a name, a value): breaks anywhere, keeps its lines. */
export function PlainText({
  as: Element = "p",
  size,
  children,
  className,
  ...rest
}: {
  as?: "p" | "li";
  size?: "small";
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(
        "wrap-anywhere whitespace-pre-wrap",
        size === "small" && "text-small",
        className,
      )}
      {...rest}
    >
      {children}
    </Element>
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

/** The modal dialog lives in its own file (the base-maia copy on Base UI); screens import it from here. */
export { Dialog } from "./dialog.js";

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
