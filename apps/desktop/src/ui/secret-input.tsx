import { Eye, EyeOff } from "lucide-react";
import { type Ref, useId, useImperativeHandle, useRef, useState } from "react";

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
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  useImperativeHandle(
    ref,
    () => ({
      take: () => input.current?.value ?? "",
      clear: () => {
        if (input.current !== null) input.current.value = "";
        setRevealed(false);
      },
      focus: () => input.current?.focus(),
    }),
    [],
  );
  const describedBy =
    error !== undefined ? `${id}-err` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className={`ui-field${error !== undefined ? " ui-field--error" : ""}`}>
      <label htmlFor={id} className="ui-field__label">
        {label}
      </label>
      <div className="secret-field">
        <input
          ref={input}
          id={id}
          className="ui-field__control secret-field__input"
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter !== undefined) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <button
          type="button"
          className="secret-field__reveal"
          aria-pressed={revealed}
          aria-label={revealed ? "Esconder o valor" : "Mostrar o valor"}
          title={revealed ? "Esconder o valor" : "Mostrar o valor"}
          disabled={disabled}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? (
            <EyeOff size={16} aria-hidden="true" />
          ) : (
            <Eye size={16} aria-hidden="true" />
          )}
        </button>
      </div>
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
