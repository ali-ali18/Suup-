import { ArrowUp, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx.js";
import { focusOnAppearance } from "../lib/focus.js";
import { RoundButton } from "./primitives.js";

export interface ComposerProps {
  placeholder: string;
  disabled?: boolean;
  /** Why it is disabled, said to screen readers and shown as the placeholder. */
  disabledReason?: string;
  onSend(text: string): void;
  /** Text given back after a failed send (the draft is restored). */
  restore?: { text: string; nonce: number } | undefined;
  /**
   * A draft put in by the app ("Editar" on a routine): it replaces the text, and the field takes
   * the focus with the caret at the end, for the person to finish it.
   */
  prefill?: { text: string; nonce: number } | undefined;
  /** Every change the PERSON makes to the draft (typing, cutting); not the clearing after a send. */
  onTextChange?(text: string): void;
  /** Shown just above the field: what the draft is bound to (a routine), with its remove. */
  attachment?: ReactNode;
  autoFocus?: boolean;
}

const MAX_HEIGHT = 200;

/**
 * The composer (Figma v2/Compositor, without the microphone): Enter sends, Shift+Enter breaks the
 * line, nothing is sent empty or while composing with an input method.
 */
export function Composer({
  placeholder,
  disabled,
  disabledReason,
  onSend,
  restore,
  prefill,
  onTextChange,
  attachment,
  autoFocus,
}: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Take the focus when the composer appears (not the `autoFocus` attribute: it would also steal
  // the focus from the palette or a dialog that is already open when the chat mounts).
  useEffect(() => {
    if (autoFocus === true && disabled !== true) focusOnAppearance(ref.current);
  }, []);

  useEffect(() => {
    if (restore !== undefined) setText((current) => (current === "" ? restore.text : current));
  }, [restore]);

  // A draft from the app: in the field, focused, the caret at the end.
  useEffect(() => {
    if (prefill === undefined) return;
    setText(prefill.text);
    const el = ref.current;
    if (el === null) return;
    el.value = prefill.text;
    el.focus({ preventScroll: true });
    el.setSelectionRange(prefill.text.length, prefill.text.length);
  }, [prefill]);

  // Grow with the text, up to a limit; then it scrolls inside.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const canSend = !disabled && text.trim() !== "";
  const send = () => {
    if (!canSend) return;
    onSend(text);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const box = (
    <div
      className={cx(
        "flex min-h-14 items-end gap-2 rounded-composer border border-border bg-raised py-2 pr-2 pl-5 focus-within:border-border-strong",
        disabled && "opacity-60",
      )}
    >
      <RoundButton label="Anexar (ainda não disponível)" tone="ghost" disabled>
        <Plus size={18} aria-hidden="true" />
      </RoundButton>
      <textarea
        ref={ref}
        rows={1}
        className="max-h-50 min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-2 text-body text-text outline-none placeholder:text-text-muted"
        aria-label="Mensagem"
        placeholder={disabled && disabledReason !== undefined ? disabledReason : placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onTextChange?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <RoundButton label="Enviar mensagem" tone="bot" disabled={!canSend} onClick={send}>
        <ArrowUp size={16} aria-hidden="true" />
      </RoundButton>
    </div>
  );
  if (attachment === undefined || attachment === null) return box;
  return (
    <div className="flex flex-col gap-2">
      {attachment}
      {box}
    </div>
  );
}
