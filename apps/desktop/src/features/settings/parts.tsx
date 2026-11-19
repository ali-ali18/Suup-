import { type LucideIcon, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Dropdown } from "../../ui/dropdown.js";
import { Pill } from "../../ui/primitives.js";

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
    <section className="sgroup" aria-label={label} data-testid={testId}>
      {label !== undefined && (
        <h3 className="sgroup__label">
          {Icon !== undefined && <Icon size={16} aria-hidden="true" />}
          {label}
        </h3>
      )}
      <div className={`scard${plain === true ? " scard--plain" : ""}`}>{children}</div>
      {hint !== undefined && <p className="sgroup__hint">{hint}</p>}
    </section>
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
    <div className="srow" data-testid={testId} {...(role === undefined ? {} : { role })}>
      <div className="srow__main">
        {Icon !== undefined && (
          <span className="srow__icon" aria-hidden="true">
            <Icon size={16} />
          </span>
        )}
        <div className="srow__text">
          <span className="srow__title" id={titleId} data-testid={titleTestId}>
            {title}
          </span>
          {description !== undefined && (
            <span className="srow__desc" data-testid={descriptionTestId}>
              {description}
            </span>
          )}
        </div>
      </div>
      {control !== undefined && <div className="srow__control">{control}</div>}
    </div>
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
 * The one style of a row's action (docs/DESIGN.md §3c): a secondary pill. "Adicionar regra",
 * "Abrir", "Editar", "Gerenciar", "Testar", "Revisar"... in every section. The destructive one
 * ("Remover", "Apagar") is the same pill in the danger tone; never bare text.
 */
export function RowAction({
  children,
  danger,
  ...rest
}: Omit<ComponentProps<typeof Pill>, "tone" | "className"> & { danger?: boolean }) {
  return (
    <Pill tone={danger === true ? "danger" : "secondary"} className="spill" {...rest}>
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
    <div className="spane__head">
      <h2 id={titleId} className="spane__title">
        {title}
      </h2>
      <div className="spane__tools">
        {children}
        <button
          type="button"
          className="ui-dialog__x"
          aria-label="Fechar as configurações"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface SectionProps {
  title: string | undefined;
  titleId: string;
  onClose(): void;
}
