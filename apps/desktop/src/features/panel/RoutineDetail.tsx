import type { Routine } from "@suup/api";
import { ArrowLeft, Clock, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { Markdown } from "../../lib/markdown.js";
import { describeSchedule, editDraft } from "../../lib/routines.js";
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

/** A section of the detail, as in the Grok Bot: a label of 30 px and what it holds. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col" aria-label={title}>
      <h3 className="flex h-7.5 items-center px-2 text-label font-normal text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The detail of a routine, in the bot's panel in place of the list (docs/DESIGN.md §5b), built as
 * the Grok Bot's (read in its code with the REA, 23/11/2026): a header (the way back and the name),
 * the content in two sections, "Instrução" (what the routine asks the bot, in Markdown) and "Quando
 * executar" (a row with the clock and the schedule in words), and at the foot of the column the
 * actions in one row: Pausar or Retomar, Testar (run once now), Editar (to the chat, by asking the
 * bot), each one an equal share of the width, and the trash circle (Remover, a dialog). When it
 * runs, the bot's answer arrives in the chat. Read from `/v1/routines/{id}`, again when a run of
 * the bot changes.
 */
export function RoutineDetail({ botId, routineId }: { botId: string; routineId: string }) {
  const { api, platform } = useServices();
  const favicons = useSettings((s) => s.settings.favicons === "on");
  const customFrame = useUi((s) => s.customFrame);
  const toast = useUi((s) => s.toast);
  const openPanelRoutine = useUi((s) => s.openPanelRoutine);
  const editRoutineInChat = useUi((s) => s.editRoutineInChat);
  const [routine, setRoutine] = useState<Routine | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [running, setRunning] = useState(false);
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
  const paused = routine?.status === "paused";
  const togglePause = () => {
    if (routine === undefined) return;
    api.routines
      .update(routine.id, { paused: !paused })
      .then(setRoutine, (e: unknown) => toast(messageOf(e), "error"));
  };
  const runNow = () => {
    if (routine === undefined) return;
    setRunning(true);
    api.routines.run(routine.id).then(
      () => {
        setRunning(false);
        toast(`“${routine.name}” começou a rodar. O resultado chega no chat.`, "info");
      },
      (e: unknown) => {
        setRunning(false);
        toast(messageOf(e), "error");
      },
    );
  };

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
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-6">
        {error !== undefined && <FieldError>{error}</FieldError>}
        {routine !== undefined && (
          <div className="flex flex-col gap-3">
            <Section title="Instrução">
              <div className="px-2" data-testid="routine-instruction">
                <Markdown
                  text={routine.instruction}
                  openUrl={platform.openUrl}
                  favicons={favicons}
                />
              </div>
            </Section>
            <Section title="Quando executar">
              <ul className="flex list-none flex-col gap-0.5 p-0" aria-label="Quando executar">
                <li className="flex items-center gap-2 px-2 py-1 text-body text-text-muted">
                  <Clock size={16} className="flex-none" aria-hidden="true" />
                  <span data-testid="routine-schedule">{describeSchedule(routine.schedule)}</span>
                </li>
              </ul>
            </Section>
          </div>
        )}
      </div>
      {routine !== undefined && (
        <div className="flex flex-none items-stretch gap-2 px-3 pb-3" data-testid="routine-actions">
          <Pill
            className="flex-1"
            disabled={routine.status === "ended"}
            onClick={togglePause}
            data-testid="routine-pause"
          >
            {paused ? "Retomar" : "Pausar"}
          </Pill>
          <Pill className="flex-1" disabled={running} onClick={runNow} data-testid="routine-run">
            {running ? "Em execução…" : "Testar"}
          </Pill>
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
          <RoundButton
            label="Excluir rotina"
            tone="raised"
            onClick={() => setRemoving(true)}
            data-testid="routine-remove"
          >
            <Trash2 size={16} className="text-danger-text" aria-hidden="true" />
          </RoundButton>
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
