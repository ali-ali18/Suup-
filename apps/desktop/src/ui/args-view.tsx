import { Lock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cx } from "../lib/cx.js";
import {
  type ArgField,
  collapsedText,
  formatArgs,
  type Segment,
  splitSecrets,
} from "../lib/format-args.js";
import { ActionLabel } from "./action-card.js";

/** A secret as the card shows it: its placeholder, with a lock. Never a value (the card has none). */
export function SecretSeal({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-pill border border-border-strong bg-raised px-2 whitespace-nowrap text-text"
      data-testid="secret-seal"
      title={`Usa o segredo ${name}`}
    >
      <Lock size={12} aria-hidden="true" />
      <span>{`{{secret:${name}}}`}</span>
    </span>
  );
}

function Segments({ text }: { text: string }) {
  const segments: Segment[] = splitSecrets(text);
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "secret" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one text never reorder
          <SecretSeal key={`${i}-${segment.name}`} name={segment.name} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one text never reorder
          <span key={`${i}-t`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Field names that hold code, compared exactly (no pattern on names). */
const CODE_KEYS: ReadonlySet<string> = new Set([
  "command",
  "cmd",
  "script",
  "code",
  "query",
  "sql",
  "json",
  "patch",
  "diff",
  "regex",
  "pattern",
]);

/** Monospace only for what is code: a command, a script, a query, or anything on several lines. */
const isCodeLike = (field: ArgField): boolean =>
  field.json || field.lines > 1 || (field.key !== null && CODE_KEYS.has(field.key.toLowerCase()));

/** One quiet row: a hairline above, the label at the left and the value after it. */
const FIELD_ROW =
  "grid min-w-0 grid-cols-[minmax(var(--width-arg-key-min),var(--width-arg-key-max))_minmax(0,1fr)] items-baseline gap-x-4 border-t border-border py-3 last:border-b";
const KEY = "m-0 text-small text-text-muted wrap-anywhere";
const BODY = "flex min-w-0 flex-col items-start gap-1 text-label";

/** One quiet row: its label at the left, its value after it, a hairline above. */
export function ArgRow({
  label,
  children,
  testId,
}: {
  label: string | null;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className={FIELD_ROW} data-testid={testId}>
      {label !== null && <p className={KEY}>{label}</p>}
      <div className={BODY}>{children}</div>
    </div>
  );
}

function FieldView({ field, collapse }: { field: ArgField; collapse: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const folded = collapse && field.long && !open;
  const shown = folded ? collapsedText(field.text) : { head: field.text, hiddenLines: 0 };
  return (
    <div
      className={FIELD_ROW}
      data-testid="arg-field"
      data-key={field.key ?? ""}
      data-code={isCodeLike(field)}
    >
      {field.key !== null && <p className={KEY}>{field.key}</p>}
      <div className={BODY}>
        <pre
          id={bodyId}
          className={cx(
            "m-0 max-h-80 max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap text-text",
            // Monospace only for what is code: the rest keeps the text of the row.
            isCodeLike(field) ? "font-mono text-code" : "[font:inherit]",
          )}
          data-testid="arg-value"
        >
          <Segments text={shown.head} />
          {folded ? "…" : ""}
        </pre>
        {collapse && field.long && (
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-small text-text-muted underline hover:text-text"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
          >
            {open
              ? "Mostrar menos"
              : shown.hiddenLines > 0
                ? `Mostrar tudo (mais ${shown.hiddenLines} ${shown.hiddenLines === 1 ? "linha" : "linhas"})`
                : "Mostrar tudo"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The exact content of a call as quiet rows: each argument as it was sent (label, then value),
 * secrets as their placeholder, long content collapsed (when `collapse`) with a button that shows
 * all of it. `children` are extra rows before the arguments.
 */
export function ArgsView({
  args,
  collapse,
  children,
  testId = "approval-args",
  omitKeys,
}: {
  args: unknown;
  collapse: boolean;
  children?: ReactNode;
  testId?: string;
  /**
   * Arguments the card already states in its own words (compared exactly by name): they get no row
   * here. The card must then offer the full content some other way.
   */
  omitKeys?: ReadonlySet<string>;
}) {
  const all = formatArgs(args);
  const fields = all.filter((f) => f.key === null || omitKeys?.has(f.key) !== true);
  return (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      {children}
      {all.length === 0 && (
        <ActionLabel className="py-3">Esta ação não leva argumentos.</ActionLabel>
      )}
      {fields.map((field, i) => (
        <FieldView key={field.key ?? `field-${i}`} field={field} collapse={collapse} />
      ))}
    </div>
  );
}
