import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The pieces every settings section is built from (docs/DESIGN.md §3c): a small faded group label
 * above a rounded card of simple rows, each row a label on the left and ONE control on the right.
 */
export function SettingsGroup({
  label,
  hint,
  plain,
  children,
  testId,
}: {
  /** The small faded label above the card; omitted for a card that stands alone. */
  label?: string;
  /** One faded line under the card. */
  hint?: string;
  /** Rows with no card around them (a heading row and its list). */
  plain?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="sgroup" aria-label={label} data-testid={testId}>
      {label !== undefined && <h3 className="sgroup__label">{label}</h3>}
      <div className={`scard${plain === true ? " scard--plain" : ""}`}>{children}</div>
      {hint !== undefined && <p className="sgroup__hint">{hint}</p>}
    </section>
  );
}

/** A row: the title (and one faded line) on the left, the control on the right. */
export function SettingsRow({
  title,
  description,
  descriptionTestId,
  control,
  testId,
  titleId,
  role,
}: {
  title: string;
  description?: ReactNode;
  descriptionTestId?: string;
  control?: ReactNode;
  testId?: string;
  titleId?: string;
  /** `status` for a calm notice (a definition waiting for review). */
  role?: "status";
}) {
  return (
    <div className="srow" data-testid={testId} {...(role === undefined ? {} : { role })}>
      <div className="srow__text">
        <span className="srow__title" id={titleId}>
          {title}
        </span>
        {description !== undefined && (
          <span className="srow__desc" data-testid={descriptionTestId}>
            {description}
          </span>
        )}
      </div>
      {control !== undefined && <div className="srow__control">{control}</div>}
    </div>
  );
}

/** The quiet dropdown of a row: its text and a chevron, no box until it is hovered. */
export function SettingsSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange(value: V): void;
  testId?: string;
}) {
  return (
    <select
      className="sselect"
      aria-label={label}
      value={value}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value as V)}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
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
