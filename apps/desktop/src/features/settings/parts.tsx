import { type LucideIcon, X } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { Dropdown } from "../../ui/dropdown.js";
import { IconButton, Pill } from "../../ui/primitives.js";

/** The separator between rows runs the card's FULL width, edge to edge (docs/DESIGN.md §3c). */
const SEPARATORS =
  "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-[calc(-1*var(--scard-pad))] [&>*+*]:before:top-0 [&>*+*]:before:border-t [&>*+*]:before:border-border [&>*+*]:before:content-['']";

/**
 * The pieces every settings section is built from (docs/DESIGN.md §3c): a small faded group label
 * above a rounded card of simple rows, each row a label on the left and ONE control on the right.
 */
export function SettingsGroup({
  label,
  icon: Icon,
  hint,
  plain,
  children,
  testId,
}: {
  /** The small faded label above the card; omitted for a card that stands alone. */
  label?: string;
  /** A small muted icon before the label (the same size as the nav's). */
  icon?: LucideIcon;
  /** One faded line under the card. */
  hint?: string;
  /** Rows with no card around them (a heading row and its list). */
  plain?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={label} data-testid={testId}>
      {label !== undefined && (
        <h3 className="flex items-center gap-2 px-2 text-small font-label text-text-muted">
          {Icon !== undefined && <Icon size={16} aria-hidden="true" />}
          {label}
        </h3>
      )}
      <SettingsCard plain={plain === true}>{children}</SettingsCard>
      {hint !== undefined && <SettingsHint>{hint}</SettingsHint>}
    </section>
  );
}

/**
 * The card of rows: the separators between its children reach back over its padding (`--scard-pad`),
 * to the card's edge. `plain` has no card around the rows. `as` is the element (a list of tools).
 */
export function SettingsCard({
  plain,
  as: Element = "div",
  children,
  ...rest
}: {
  plain?: boolean;
  as?: "div" | "ul";
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(
        "flex flex-col",
        plain === true
          ? "[--scard-pad:var(--space-0)]"
          : cx(
              "rounded-card border border-border bg-surface px-4 py-1 [--scard-pad:var(--space-4)]",
              SEPARATORS,
            ),
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** Rows that are not direct children of the card (a list of tools, of connectors): same separators. */
export function SettingsList({
  as: Element = "div",
  children,
  ...rest
}: { as?: "div" | "ul"; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Element className={cx("m-0 flex list-none flex-col p-0", SEPARATORS)} {...rest}>
      {children}
    </Element>
  );
}

/** One faded line under a card, or inside a folded row. */
export function SettingsHint({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="px-2 text-small text-text-muted" {...rest}>
      {children}
    </p>
  );
}

/** What a row opens to: shortcuts, a form, a list, and its footer buttons. */
export function SettingsFold({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="flex flex-col gap-3 pt-2 pb-4" {...rest}>
      {children}
    </div>
  );
}

/** The empty or loading line of a pane. */
export function SettingsEmpty({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className="px-5 py-8 text-center text-label text-text-muted" {...rest}>
      {children}
    </p>
  );
}

/** A group of things in a pane, one under the other (the details of a connector). */
export function SettingsStack({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="flex flex-col gap-5" {...rest}>
      {children}
    </div>
  );
}

/** The skeleton of a row: the same height and spacing for every row of every section. */
export function RowShell({
  as: Element = "div",
  tight,
  children,
  ...rest
}: {
  as?: "div" | "li";
  /** A row with a checkbox in front keeps its parts closer. */
  tight?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      className={cx(
        "flex min-h-13 items-center justify-between py-3 narrow:flex-wrap",
        tight === true ? "gap-3" : "gap-4",
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}

/** The title and the faded line of a row. `grow` makes them take the room between the other parts. */
export function RowText({ grow, children }: { grow?: boolean; children: ReactNode }) {
  return <div className={cx("flex min-w-0 flex-col", grow === true && "flex-1")}>{children}</div>;
}

export function RowTitle({
  as: Element = "span",
  children,
  ...rest
}: {
  as?: "span" | "label";
  children: ReactNode;
} & HTMLAttributes<HTMLElement> & { htmlFor?: string }) {
  return (
    <Element className="text-label font-label wrap-anywhere" {...rest}>
      {children}
    </Element>
  );
}

export function RowDescription({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="text-small wrap-anywhere text-text-muted" {...rest}>
      {children}
    </span>
  );
}

/** The right side of a row. `end` is the footer of a folded row: all the width, buttons at the end. */
export function RowControl({ end, children }: { end?: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        "flex flex-none items-center gap-2",
        end === true ? "max-w-none justify-end" : "max-w-1/2 narrow:max-w-full",
      )}
    >
      {children}
    </div>
  );
}

/** A faded value at the right of a row ("Alto", "3 de 14"). */
export function RowValue({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="text-right text-small text-text-muted" {...rest}>
      {children}
    </span>
  );
}

/** One more line of the faded text of a row (a block of its own). */
export function RowLine({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("block", className)} {...rest}>
      {children}
    </span>
  );
}

/**
 * A row: the title (and one faded line) on the left, the control on the right. `icon` is the one
 * leading slot of every row (16 px, muted, the size and stroke of the nav's icons): the same place
 * in every section, never a second control.
 */
export function SettingsRow({
  icon: Icon,
  title,
  description,
  descriptionTestId,
  control,
  testId,
  titleId,
  titleTestId,
  role,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  descriptionTestId?: string;
  control?: ReactNode;
  testId?: string;
  titleId?: string;
  titleTestId?: string;
  /** `status` for a calm notice (a definition waiting for review), `note` for a standing warning. */
  role?: "status" | "note";
}) {
  return (
    <RowShell data-testid={testId} {...(role === undefined ? {} : { role })}>
      <div className="flex min-w-0 items-center gap-3">
        {Icon !== undefined && (
          <span className="inline-flex flex-none text-text-muted" aria-hidden="true">
            <Icon size={16} />
          </span>
        )}
        <RowText>
          <RowTitle id={titleId} data-testid={titleTestId}>
            {title}
          </RowTitle>
          {description !== undefined && (
            <RowDescription data-testid={descriptionTestId}>{description}</RowDescription>
          )}
        </RowText>
      </div>
      {control !== undefined && <RowControl>{control}</RowControl>}
    </RowShell>
  );
}

/**
 * The quiet dropdown of a row: its text and a chevron, no box until it is hovered (`ui/dropdown.tsx`).
 * An option may carry a third item, a faded line shown under its name in the open menu.
 */
export function SettingsSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled,
  placeholder,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string] | readonly [V, string, string])[];
  onChange(value: V): void;
  testId?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Dropdown
      label={label}
      value={value}
      options={options.map(([v, text, description]) => ({
        value: v,
        label: text,
        ...(description === undefined ? {} : { description }),
      }))}
      onChange={onChange}
      {...(testId === undefined ? {} : { testId })}
      {...(disabled === undefined ? {} : { disabled })}
      {...(placeholder === undefined ? {} : { placeholder })}
    />
  );
}

/**
 * The one style of a row's action (docs/DESIGN.md §3c): a small secondary pill. "Adicionar regra",
 * "Abrir", "Editar", "Gerenciar", "Testar", "Revisar"... in every section. The destructive one
 * ("Remover", "Apagar") is the same pill in the danger tone; never bare text.
 */
export function RowAction({
  children,
  danger,
  ...rest
}: Omit<ComponentProps<typeof Pill>, "tone" | "className" | "size"> & { danger?: boolean }) {
  return (
    <Pill tone={danger === true ? "danger" : "secondary"} size="sm" {...rest}>
      {children}
    </Pill>
  );
}

/** The head of a section: its title on the left, its own tools and the close X on the right. */
export function PaneHead({
  title,
  titleId,
  onClose,
  children,
}: {
  title: string | undefined;
  titleId: string;
  onClose(): void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-none items-center justify-between gap-3 pt-5 pr-5 pb-3 pl-6">
      <h2 id={titleId} className="text-settings-title font-label">
        {title}
      </h2>
      <div className="flex items-center gap-2">
        {children}
        <IconButton label="Fechar as configurações" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

/** The scrolling body of a section. */
export function PaneBody({
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-2 pb-6 narrow:px-4"
      {...rest}
    >
      {children}
    </div>
  );
}

export interface SectionProps {
  title: string | undefined;
  titleId: string;
  onClose(): void;
}
