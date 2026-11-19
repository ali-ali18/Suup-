import type { Memory, MemoryRevision } from "@suup/api";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { ACTOR_LABEL, REVISION_KIND_LABEL } from "../../data/memory-text.js";
import { messageOf } from "../../data/sync.js";
import { Dialog, FieldError, MutedText, Pill, PlainText } from "../../ui/primitives.js";
import { whenLabel } from "./labels.js";

/** One change: what it was, who made it and when; the text before it and after it. */
function RevisionRow({
  revision,
  latest,
  busy,
  onUndo,
}: {
  revision: MemoryRevision;
  latest: boolean;
  busy: boolean;
  onUndo(): void;
}) {
  const changed = revision.prev !== null && revision.prev.text !== revision.next.text;
  return (
    <li
      className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0"
      data-testid="memory-revision"
      data-kind={revision.kind}
      data-actor={revision.actor}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-label">
          <strong className="font-title">{REVISION_KIND_LABEL[revision.kind]}</strong>
          <MutedText size="inherit">
            {" "}
            · {ACTOR_LABEL[revision.actor]} · {whenLabel(revision.createdAt)}
          </MutedText>
        </span>
        {latest && (
          <Pill
            tone="secondary"
            size="sm"
            disabled={busy}
            data-testid="memory-undo"
            onClick={onUndo}
          >
            Desfazer
          </Pill>
        )}
      </div>
      {changed && revision.prev !== null && (
        <MutedText as="p" className="wrap-anywhere" data-testid="revision-prev">
          Antes: {revision.prev.text}
        </MutedText>
      )}
      <PlainText className="text-label" data-testid="revision-next">
        {changed ? `Agora: ${revision.next.text}` : revision.next.text}
      </PlainText>
    </li>
  );
}

/**
 * The changes of one memory, newest first: what happened, who did it (you, the bot, the
 * consolidation or the validity), when, and the text before and after. Only the latest can be
 * undone ("Desfazer"); undoing is a change too, so it shows up at the top of the list.
 */
export function MemoryHistoryDialog({ memory, onClose }: { memory: Memory; onClose(): void }) {
  const { api, sync } = useServices();
  const [revisions, setRevisions] = useState<MemoryRevision[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRevisions(await api.memories.history(memory.id));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [api, memory.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (revision: MemoryRevision) => {
    setBusy(true);
    setError(undefined);
    try {
      sync.mergeMemoryNow(await api.memories.undo(memory.id, revision.id));
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
    setBusy(false);
  };

  return (
    <Dialog
      title="Histórico da memória"
      onClose={onClose}
      footer={
        <Pill tone="secondary" onClick={onClose} data-testid="memory-history-close">
          Fechar
        </Pill>
      }
    >
      <div className="flex flex-col gap-3" data-testid="memory-history">
        <MutedText as="p" className="wrap-anywhere">
          {memory.text}
        </MutedText>
        {error !== undefined && <FieldError data-testid="memory-history-error">{error}</FieldError>}
        {revisions === undefined ? (
          error === undefined && (
            <MutedText as="p" role="status">
              Carregando…
            </MutedText>
          )
        ) : revisions.length === 0 ? (
          <MutedText as="p">Nenhuma mudança registrada.</MutedText>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {revisions.map((revision, index) => (
              <RevisionRow
                key={revision.id}
                revision={revision}
                latest={index === 0}
                busy={busy}
                onUndo={() => void undo(revision)}
              />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
