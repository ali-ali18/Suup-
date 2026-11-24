import { ArrowUp, AudioLines, Mic, Plus } from "lucide-react";
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
  /** Each new value moves the focus into the field (the X of a question: "answer in the chat"). */
  focusRequest?: number;
}

const MAX_HEIGHT = 200;

/**
 * The composer (Figma v2/Compositor, slimmer, as in the Grok Bot: owner's decision, 22/11/2026):
 * Enter sends, Shift+Enter breaks the line, nothing is sent empty or while composing with an input
 * method. On the right, with no text, there are the dictation and the call: the backend has neither
 * yet, so they are ornaments (`aria-hidden`, dimmed, nothing to click). With text, the call's place
 * is taken by the real send button.
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
  focusRequest,
}: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Take the focus when the composer appears (not the `autoFocus` attribute: it would also steal
  // the focus from the palette or a dialog that is already open when the chat mounts).
  useEffect(() => {
    if (autoFocus === true && disabled !== true) focusOnAppearance(ref.current);
  }, []);

  useEffect(() => {
    if (focusRequest !== undefined && focusRequest > 0) focusOnAppearance(ref.current);
  }, [focusRequest]);

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
        "flex min-h-12 items-end gap-2 rounded-composer border border-border bg-raised p-2 focus-within:border-border-strong",
        disabled && "opacity-60",
      )}
    >
      <RoundButton label="Anexar (ainda não disponível)" tone="ghost" size="sm" disabled>
        <Plus size={18} aria-hidden="true" />
      </RoundButton>
      <textarea
        ref={ref}
        rows={1}
        className="max-h-50 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-body text-text outline-none placeholder:text-text-muted"
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
      {canSend ? (
        <RoundButton label="Enviar mensagem" tone="bot" size="sm" onClick={send}>
          <ArrowUp size={16} aria-hidden="true" />
        </RoundButton>
      ) : (
        <>
          <span
            className="inline-flex size-8 flex-none items-center justify-center text-text-muted opacity-60"
            aria-hidden="true"
            data-testid="ornament-dictation"
          >
            <Mic size={16} />
          </span>
          <span
            className="inline-flex size-8 flex-none items-center justify-center rounded-pill bg-bot-fill text-bot-on-fill opacity-60 bubble-neutral:bg-bg-inverse bubble-neutral:text-text-inverse"
            aria-hidden="true"
            data-testid="ornament-call"
          >
            <AudioLines size={16} />
          </span>
        </>
      )}
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
