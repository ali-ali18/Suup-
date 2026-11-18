import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Pill, RoundButton, Tag, TextField } from "./primitives.js";

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
}

/** An item of the memory (Figma v2/Item de memória): normal, or forgotten (can be restored). */
export function MemoryItem(p: MemoryItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  return (
    <li
      className={`ui-memory${p.archived ? " ui-memory--archived" : ""}`}
      data-testid="memory-item"
    >
      {editing ? (
        <div className="ui-memory__edit">
          <TextField
            label="Texto da memória"
            value={draft}
            onChange={setDraft}
            multiline
            rows={3}
            autoFocus
          />
          <div className="ui-memory__actions">
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
          <p className="ui-memory__text wrap">{p.text}</p>
          <div className="ui-memory__foot">
            <span className="ui-memory__tags">
              <Tag>{p.layerLabel}</Tag>
              <Tag tone="outline">{p.scopeLabel}</Tag>
              {p.archived && <Tag tone="outline">Esquecida</Tag>}
            </span>
            <span className="ui-memory__meta small muted">
              {p.authorLabel} · {p.dateLabel}
            </span>
            <span className="ui-memory__actions">
              {p.archived ? (
                <Pill
                  tone="secondary"
                  icon={<RotateCcw size={14} aria-hidden="true" />}
                  onClick={p.onRestore}
                >
                  Restaurar
                </Pill>
              ) : (
                <>
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
