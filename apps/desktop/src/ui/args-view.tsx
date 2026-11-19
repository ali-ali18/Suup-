import { Lock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import {
  type ArgField,
  collapsedText,
  formatArgs,
  type Segment,
  splitSecrets,
} from "../lib/format-args.js";

/** A secret as the card shows it: its placeholder, with a lock. Never a value (the card has none). */
export function SecretSeal({ name }: { name: string }) {
  return (
    <span className="ui-secret-seal" data-testid="secret-seal" title={`Usa o segredo ${name}`}>
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
    <div className="ui-args__field" data-testid={testId}>
      {label !== null && <p className="ui-args__key">{label}</p>}
      <div className="ui-args__body">{children}</div>
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
      className="ui-args__field"
      data-testid="arg-field"
      data-key={field.key ?? ""}
      data-code={isCodeLike(field)}
    >
      {field.key !== null && <p className="ui-args__key">{field.key}</p>}
      <div className="ui-args__body">
        <pre id={bodyId} className="ui-args__value" data-testid="arg-value">
          <Segments text={shown.head} />
          {folded ? "…" : ""}
        </pre>
        {collapse && field.long && (
          <button
            type="button"
            className="ui-args__more"
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
    <div className="ui-args" data-testid={testId}>
      {children}
      {all.length === 0 && (
        <p className="ui-action__label ui-args__empty">Esta ação não leva argumentos.</p>
      )}
      {fields.map((field, i) => (
        <FieldView key={field.key ?? `field-${i}`} field={field} collapse={collapse} />
      ))}
    </div>
  );
}
