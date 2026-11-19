import { History, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { cx } from "../lib/cx.js";
import { MutedText, Pill, PlainText, RoundButton, Tag, TextField } from "./primitives.js";

export interface MemoryItemProps {
  text: string;
  layerLabel: string;
  scopeLabel: string;
  authorLabel: string;
  dateLabel: string;
  archived: boolean;
  /** The layers a person writes are editable; the diary is the system's. */
  editable: boolean;
  onEdit(text: string): void;
  onForget(): void;
  onRestore(): void;
  compact?: boolean;
  /** The fact in one short line (a note, a journal entry): faded under the text. */
  summary?: string | null | undefined;
  /** Opens the list of changes of this memory. */
  onHistory?(): void;
  /**
   * A proposal that waits for you: "Descartar" and "Guardar" instead of the edit and forget
   * buttons. `replacesText` is what it would replace; `reviewReason` is why it was held.
   */
  pending?: {
    onConfirm(): void;
    onReject(): void;
    busy: boolean;
    replacesText?: string | undefined;
    reviewReason?: string | undefined;
  };
}

/** An item of the memory (Figma v2/Item de memória): normal, or forgotten (can be restored). */
export function MemoryItem(p: MemoryItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  return (
    <li
      className="flex flex-col gap-3 rounded-row border border-border bg-surface p-4"
      data-testid="memory-item"
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          <TextField
            label="Texto da memória"
            value={draft}
            onChange={setDraft}
            multiline
            rows={3}
            autoFocus
          />
          <div className="ml-auto inline-flex gap-1">
            <Pill
              tone="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(p.text);
              }}
            >
              Cancelar
            </Pill>
            <Pill
              tone="primary"
              disabled={draft.trim() === ""}
              onClick={() => {
                p.onEdit(draft.trim());
                setEditing(false);
              }}
            >
              Salvar
            </Pill>
          </div>
        </div>
      ) : (
        <>
          <PlainText className={cx("text-body", p.archived && "text-text-muted line-through")}>
            {p.text}
          </PlainText>
          {p.summary !== undefined && p.summary !== null && p.summary !== "" && (
            <MutedText data-testid="memory-summary">{p.summary}</MutedText>
          )}
          {p.pending?.replacesText !== undefined && (
            <MutedText data-testid="memory-replaces">Substitui: {p.pending.replacesText}</MutedText>
          )}
          {p.pending?.reviewReason !== undefined && (
            <MutedText data-testid="memory-review">{p.pending.reviewReason}</MutedText>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex flex-wrap gap-1">
              <Tag>{p.layerLabel}</Tag>
              <Tag tone="outline">{p.scopeLabel}</Tag>
              {p.archived && <Tag tone="outline">Esquecida</Tag>}
              {p.pending !== undefined && <Tag tone="outline">Pendente</Tag>}
            </span>
            <MutedText className="min-w-0 flex-1">
              {p.authorLabel} · {p.dateLabel}
            </MutedText>
            <span className="ml-auto inline-flex gap-1">
              {p.pending !== undefined ? (
                <>
                  <Pill
                    tone="quiet"
                    disabled={p.pending.busy}
                    data-testid="memory-reject"
                    onClick={p.pending.onReject}
                  >
                    Descartar
                  </Pill>
                  <Pill
                    tone="primary"
                    disabled={p.pending.busy}
                    data-testid="memory-confirm"
                    onClick={p.pending.onConfirm}
                  >
                    Guardar
                  </Pill>
                </>
              ) : p.archived ? (
                <>
                  {p.onHistory !== undefined && (
                    <RoundButton
                      label="Histórico da memória"
                      tone="ghost"
                      size="sm"
                      onClick={p.onHistory}
                    >
                      <History size={16} aria-hidden="true" />
                    </RoundButton>
                  )}
                  <Pill
                    tone="secondary"
                    icon={<RotateCcw size={14} aria-hidden="true" />}
                    onClick={p.onRestore}
                  >
                    Restaurar
                  </Pill>
                </>
              ) : (
                <>
                  {p.onHistory !== undefined && (
                    <RoundButton
                      label="Histórico da memória"
                      tone="ghost"
                      size="sm"
                      onClick={p.onHistory}
                    >
                      <History size={16} aria-hidden="true" />
                    </RoundButton>
                  )}
                  {p.editable && (
                    <RoundButton
                      label="Editar memória"
                      tone="ghost"
                      size="sm"
                      onClick={() => {
                        setDraft(p.text);
                        setEditing(true);
                      }}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </RoundButton>
                  )}
                  <RoundButton label="Esquecer memória" tone="ghost" size="sm" onClick={p.onForget}>
                    <Trash2 size={16} aria-hidden="true" />
                  </RoundButton>
                </>
              )}
            </span>
          </div>
        </>
      )}
    </li>
  );
}
