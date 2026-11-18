import { ArrowUp, Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { RoundButton } from "./primitives.js";

export interface ComposerProps {
  placeholder: string;
  disabled?: boolean;
  /** Why it is disabled, said to screen readers and shown as the placeholder. */
  disabledReason?: string;
  onSend(text: string): void;
  /** Text given back after a failed send (the draft is restored). */
  restore?: { text: string; nonce: number } | undefined;
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
  autoFocus,
}: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (restore !== undefined) setText((current) => (current === "" ? restore.text : current));
  }, [restore]);

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

  return (
    <div className={`ui-composer${disabled ? " ui-composer--disabled" : ""}`}>
      <RoundButton label="Anexar (ainda não disponível)" tone="ghost" disabled>
        <Plus size={18} aria-hidden="true" />
      </RoundButton>
      <textarea
        ref={ref}
        rows={1}
        className="ui-composer__input"
        aria-label="Mensagem"
        placeholder={disabled && disabledReason !== undefined ? disabledReason : placeholder}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <RoundButton label="Enviar mensagem" tone="primary" disabled={!canSend} onClick={send}>
        <ArrowUp size={16} aria-hidden="true" />
      </RoundButton>
    </div>
  );
}
