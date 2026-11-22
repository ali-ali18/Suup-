import { CalendarClock, X } from "lucide-react";

/**
 * What a draft of the composer is bound to (the "Editar" of a routine; docs/ROTINAS.md): a quiet
 * chip with the routine's NAME (never its id) and its remove. Removing it, or clearing the draft,
 * sends the message without the reference.
 */
export function DraftReference({ name, onRemove }: { name: string; onRemove(): void }) {
  return (
    <div
      className="inline-flex max-w-full items-center gap-2 self-start rounded-chip border border-border bg-surface py-0.5 pr-0.5 pl-2.5 text-small text-text-muted"
      data-testid="draft-routine"
    >
      <CalendarClock size={14} aria-hidden="true" className="flex-none" />
      <span className="min-w-0 truncate">
        Sobre a rotina <span className="text-text">{name}</span>
      </span>
      <button
        type="button"
        aria-label={`Tirar a rotina ${name} desta mensagem`}
        title="Tirar a rotina desta mensagem"
        className="inline-flex size-6 flex-none items-center justify-center rounded-pill border-0 bg-transparent text-text-muted hover:bg-hover hover:text-text"
        onClick={onRemove}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
