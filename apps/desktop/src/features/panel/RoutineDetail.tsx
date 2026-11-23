import type { Routine } from "@suup/api";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { Markdown } from "../../lib/markdown.js";
import { editDraft } from "../../lib/routines.js";
import { Dialog, FieldError, MutedText, Pill, RoundButton } from "../../ui/primitives.js";
import { useBotRunMark } from "./run-mark.js";

/** "Remover" asks once: the routine and its history go, what it already said stays in the chat. */
function RemoveDialog({
  routine,
  onClose,
  onRemoved,
}: {
  routine: Routine;
  onClose(): void;
  onRemoved(): void;
}) {
  const { api } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = () => {
    setBusy(true);
    api.routines.delete(routine.id).then(onRemoved, (e: unknown) => {
      setBusy(false);
      setError(messageOf(e));
    });
  };
  return (
    <Dialog
      title="Remover a rotina?"
      onClose={onClose}
      footer={
        <>
          <Pill tone="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Pill>
          <Pill tone="danger" onClick={remove} disabled={busy} data-testid="routine-remove-confirm">
            {busy ? "Removendo…" : "Remover"}
          </Pill>
        </>
      }
    >
      <MutedText as="p">
        “{routine.name}” deixa de rodar e o histórico dela some. O que ela já fez continua no chat.
      </MutedText>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Dialog>
  );
}

/**
 * The detail of a routine, in the bot's panel in place of the list (docs/DESIGN.md §5b), as in the
 * Grok Bot and nothing more: a header (the way back and the routine's name), the content (what the
 * routine asks the bot, in Markdown) and, at the foot of the column, Editar (to the chat, by asking
 * the bot) and Remover (a dialog), each one half of the full width. When it runs, the bot's answer
 * arrives in the chat. Read from `/v1/routines/{id}`, again when a run of the bot changes.
 */
export function RoutineDetail({ botId, routineId }: { botId: string; routineId: string }) {
  const { api, platform } = useServices();
  const favicons = useSettings((s) => s.settings.favicons === "on");
  const customFrame = useUi((s) => s.customFrame);
  const openPanelRoutine = useUi((s) => s.openPanelRoutine);
  const editRoutineInChat = useUi((s) => s.editRoutineInChat);
  const [routine, setRoutine] = useState<Routine | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const mark = useBotRunMark(botId);

  const load = useCallback(() => {
    api.routines.get(routineId).then(
      (r) => {
        setRoutine(r);
        setError(undefined);
      },
      (e: unknown) => setError(messageOf(e)),
    );
  }, [api, routineId]);
  useEffect(() => {
    if (mark !== null) load();
  }, [load, mark]);

  const back = () => openPanelRoutine(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="routine-detail">
      <div
        className={cx(
          "flex flex-none items-center gap-2 pt-3 pb-2 pl-3",
          customFrame ? "pr-37.5" : "pr-3",
        )}
        data-tauri-drag-region
      >
        <RoundButton label="Voltar às rotinas" tone="ghost" onClick={back}>
          <ArrowLeft size={18} aria-hidden="true" />
        </RoundButton>
        {routine !== undefined && (
          <h2 className="min-w-0 truncate text-title font-title">{routine.name}</h2>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-4">
        {error !== undefined && <FieldError>{error}</FieldError>}
        {routine !== undefined && (
          <div data-testid="routine-instruction">
            <Markdown text={routine.instruction} openUrl={platform.openUrl} favicons={favicons} />
          </div>
        )}
      </div>
      {routine !== undefined && (
        <div className="flex flex-none gap-2 px-4 pb-4" data-testid="routine-actions">
          <Pill
            className="flex-1"
            onClick={() =>
              editRoutineInChat({
                botId,
                text: editDraft(routine),
                routine: { id: routine.id, name: routine.name },
              })
            }
            data-testid="routine-edit"
          >
            Editar
          </Pill>
          <Pill
            className="flex-1"
            tone="danger"
            onClick={() => setRemoving(true)}
            data-testid="routine-remove"
          >
            Remover
          </Pill>
        </div>
      )}
      {removing && routine !== undefined && (
        <RemoveDialog
          routine={routine}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            back();
          }}
        />
      )}
    </div>
  );
}
