import { Lock } from "lucide-react";
import { useId, useState } from "react";
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

function FieldView({ field, collapse }: { field: ArgField; collapse: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const folded = collapse && field.long && !open;
  const shown = folded ? collapsedText(field.text) : { head: field.text, hiddenLines: 0 };
  return (
    <div className="ui-args__field" data-testid="arg-field" data-key={field.key ?? ""}>
      {field.key !== null && <p className="ui-action__label ui-args__key">{field.key}</p>}
      <pre id={bodyId} className="ui-action__pre ui-args__value" data-testid="arg-value">
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
  );
}

/**
 * The exact content of a call: each argument as it was sent, secrets as their placeholder, long
 * content collapsed (when `collapse`) with a button that shows all of it.
 */
export function ArgsView({ args, collapse }: { args: unknown; collapse: boolean }) {
  const fields = formatArgs(args);
  if (fields.length === 0) {
    return <p className="ui-action__label">Esta ação não leva argumentos.</p>;
  }
  return (
    <div className="ui-args" data-testid="approval-args">
      {fields.map((field, i) => (
        <FieldView key={field.key ?? `field-${i}`} field={field} collapse={collapse} />
      ))}
    </div>
  );
}
