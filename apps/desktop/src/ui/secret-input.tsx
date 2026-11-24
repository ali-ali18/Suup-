import { Eye, EyeOff } from "lucide-react";
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { Field, FieldCaption, FieldDescription, FieldMessage } from "./field.js";
import { Input } from "./input.js";
import { IconButton } from "./primitives.js";

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
  return (
    <Field invalid={error !== undefined} disabled={disabled}>
      <FieldCaption>{label}</FieldCaption>
      <div className="relative flex items-center">
        <Input
          ref={input}
          className="flex-1"
          look={{ secret: true, error: error !== undefined }}
          type={revealed ? "text" : "password"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          data-testid={testId}
          autoFocus={autoFocus}
          onValueChange={(text) => onEmptyChange?.(text === "")}
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
        <FieldMessage>{error}</FieldMessage>
      ) : hint !== undefined ? (
        <FieldDescription>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}
