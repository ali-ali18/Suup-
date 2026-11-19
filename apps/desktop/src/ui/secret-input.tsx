import { Eye, EyeOff } from "lucide-react";
import { type Ref, useId, useImperativeHandle, useRef, useState } from "react";
import { cx } from "../lib/cx.js";
import { FieldError, FieldHint, fieldControlClass, IconButton } from "./primitives.js";

/** What a screen can do with the field: take the value once, and clear it. It is never held in state. */
export interface SecretInputHandle {
  /** The text in the field right now. Call it at submit time, and then `clear()`. */
  take(): string;
  clear(): void;
  focus(): void;
}

/**
 * A field for a credential. The text lives only in the input element: no React state, no store, no
 * `value` attribute (an uncontrolled input does not reflect one), nothing logged. Hidden by default,
 * with a button to reveal it; the browser is told not to complete, suggest or spell-check it. It
 * reads nothing from the clipboard (pasting is the browser's own).
 */
export function SecretInput({
  label,
  disabled,
  hint,
  error,
  autoFocus,
  ref,
  onEnter,
  onEmptyChange,
  testId = "secret-input",
}: {
  label: string;
  disabled?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
  autoFocus?: boolean;
  ref?: Ref<SecretInputHandle>;
  /** Enter in the field (the form's submit). */
  onEnter?(): void;
  /** Whether the field is empty, told on every change: a boolean, never the text. */
  onEmptyChange?(empty: boolean): void;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  const emptyRef = useRef(onEmptyChange);
  emptyRef.current = onEmptyChange;
  useImperativeHandle(
    ref,
    () => ({
      take: () => input.current?.value ?? "",
      clear: () => {
        if (input.current !== null) input.current.value = "";
        setRevealed(false);
        emptyRef.current?.(true);
      },
      focus: () => input.current?.focus(),
    }),
    [],
  );
  const describedBy =
    error !== undefined ? `${id}-err` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small text-text-muted">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          ref={input}
          id={id}
          className={cx("flex-1", fieldControlClass({ secret: true, error: error !== undefined }))}
          type={revealed ? "text" : "password"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          data-testid={testId}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onEmptyChange?.(e.currentTarget.value === "")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter !== undefined) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <IconButton
          label={revealed ? "Esconder o valor" : "Mostrar o valor"}
          className="absolute right-1"
          aria-pressed={revealed}
          title={revealed ? "Esconder o valor" : "Mostrar o valor"}
          disabled={disabled}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? (
            <EyeOff size={16} aria-hidden="true" />
          ) : (
            <Eye size={16} aria-hidden="true" />
          )}
        </IconButton>
      </div>
      {error !== undefined ? (
        <FieldError id={`${id}-err`}>{error}</FieldError>
      ) : hint !== undefined ? (
        <FieldHint id={`${id}-hint`}>{hint}</FieldHint>
      ) : null}
    </div>
  );
}
