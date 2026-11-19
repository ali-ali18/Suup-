import { useId, useState } from "react";
import { cx } from "../lib/cx.js";

/** The field of a number, quiet like the dropdown of a settings row: no box until hover or focus. */
const FIELD_STATE = {
  normal: "border-transparent focus-visible:border-border-strong",
  invalid: "border-danger-text focus-visible:border-danger-text",
} as const;

/**
 * The number of a settings row (docs/DESIGN.md §3c): quiet, right-aligned, with a faded unit after
 * it ("min", "%", "caracteres"). It is a text field that reads a number (no native spinner), and
 * it commits on blur or Enter, never per keystroke: an empty field or text that is not a number is
 * refused here ("Digite um número."), and the **range is the server's to judge** (the server's words
 * go under the row, by the screen). Escape drops what was typed. The screen owns the value: it
 * changes it at once, and puts the old one back if the server refuses.
 */
export function NumberField({
  label,
  value,
  onCommit,
  onInvalid,
  suffix,
  invalid,
  disabled,
  testId,
}: {
  /** The accessible name (the row's title). */
  label: string;
  value: number;
  /** A new number, different from `value`. */
  onCommit(value: number): void;
  /** What was typed is not a number. */
  onInvalid?(message: string): void;
  /** The faded unit after the number. */
  suffix?: string;
  /** The row shows an error about this field. */
  invalid?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  // What is being typed; `null` while the field just shows `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === String(value)) return;
    const number = Number(text);
    if (text === "" || !Number.isFinite(number)) {
      onInvalid?.("Digite um número.");
      return;
    }
    onCommit(number);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-invalid={invalid === true ? true : undefined}
        disabled={disabled}
        data-testid={testId}
        className={cx(
          "h-8 w-20 min-w-0 rounded-pill border bg-transparent px-3 text-right text-small text-text tabular-nums focus-visible:bg-bg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus enabled:hover:bg-raised",
          FIELD_STATE[invalid === true ? "invalid" : "normal"],
        )}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== null) {
            // Drops what was typed; the dialog around keeps open.
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {suffix !== undefined && (
        <span className="text-small text-text-muted" aria-hidden="true">
          {suffix}
        </span>
      )}
    </span>
  );
}
