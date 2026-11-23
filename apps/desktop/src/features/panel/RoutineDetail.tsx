import type { Routine, RoutineFire } from "@suup/api";
import { ArrowLeft, Pause, Play, ScanSearch, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { Markdown } from "../../lib/markdown.js";
import {
  describeSchedule,
  editDraft,
  fireKindText,
  fireStatusText,
  nextText,
  whenText,
} from "../../lib/routines.js";
import {
  Dialog,
  FieldError,
  IconButton,
  MutedText,
  Pill,
  RoundButton,
} from "../../ui/primitives.js";
import { SourceChip } from "../../ui/source-chip.js";
import { useBotRunMark } from "./run-mark.js";

/** Fires shown at first, and how many more "Mostrar mais" brings (the API's ceiling is 200). */
export const FIRES_PAGE = 10;
const FIRES_MAX = 200;

/** A fire that did not run (skipped by an overlap) or is still running: one quiet line. */
const quiet = (fire: RoutineFire) => fire.status === "skipped" || fire.status === "running";

/** One fire: when and how it went, what the bot wrote (Markdown, as in the chat), and its sources. */
function FireItem({ fire, routine }: { fire: RoutineFire; routine: Routine }) {
  const { platform } = useServices();
  const openInspector = useUi((s) => s.openInspector);
  const favicons = useSettings((s) => s.settings.favicons === "on");
  const kind = fireKindText(fire);
  const head = `${whenText(fire.scheduledFor, routine.timeZone)} · ${fireStatusText(fire)}${kind === null ? "" : ` · ${kind}`}`;
  if (quiet(fire)) {
    return (
      <li className="px-4 py-3" data-testid="routine-fire" data-status={fire.status}>
        <MutedText>{head}</MutedText>
      </li>
    );
  }
  const sources = fire.sources ?? [];
  const text = fire.resultText ?? "";
  return (
    <li
      className="flex min-w-0 flex-col gap-2 px-4 py-3"
      data-testid="routine-fire"
      data-status={fire.status}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <MutedText className="min-w-0 truncate">{head}</MutedText>
        {fire.runId !== null && (
          <IconButton
            label="Ver a execução"
            title="Ver a execução"
            onClick={() => openInspector(fire.runId as string)}
          >
            <ScanSearch size={16} aria-hidden="true" />
          </IconButton>
        )}
      </span>
      {text !== "" &&
        (fire.status === "done" ? (
          <div data-testid="routine-result">
            <Markdown text={text} openUrl={platform.openUrl} favicons={favicons} />
          </div>
        ) : (
          // A failure or a cancellation: the reason, as the server wrote it.
          <MutedText
            as="p"
            className="wrap-anywhere whitespace-pre-wrap"
            data-testid="routine-result"
          >
            {text}
          </MutedText>
        ))}
      {sources.length > 0 && (
        <ul className="-ml-1.5 flex flex-wrap gap-1" aria-label="O que a execução usou">
          {sources.map((source) => (
            <li
              key={source.kind === "web" ? source.url : `connector:${source.connector}`}
              className="min-w-0"
            >
              <SourceChip source={source} favicons={favicons} openUrl={platform.openUrl} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

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
 * The detail of a routine, in the bot's panel in place of the list (docs/DESIGN.md §5b): the way
 * back and the small actions on top, then the routine in words and what the bot wrote on each fire,
 * newest first, and at the end Editar (in the chat, by asking the bot) and Remover. Everything comes
 * from `/v1/routines/{id}` and its `fires`; read again when a run of the bot changes.
 */
export function RoutineDetail({ botId, routineId }: { botId: string; routineId: string }) {
  const { api } = useServices();
  const toast = useUi((s) => s.toast);
  const openPanelRoutine = useUi((s) => s.openPanelRoutine);
  const editRoutineInChat = useUi((s) => s.editRoutineInChat);
  const [routine, setRoutine] = useState<Routine | undefined>(undefined);
  const [fires, setFires] = useState<RoutineFire[] | undefined>(undefined);
  const [limit, setLimit] = useState(FIRES_PAGE);
  const [error, setError] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const mark = useBotRunMark(botId);

  const load = useCallback(() => {
    Promise.all([api.routines.get(routineId), api.routines.fires(routineId, { limit })]).then(
      ([r, f]) => {
        setRoutine(r);
        setFires(f);
        setError(undefined);
      },
      (e: unknown) => setError(messageOf(e)),
    );
  }, [api, routineId, limit]);
  useEffect(() => {
    if (mark !== null) load();
  }, [load, mark]);
  // A fire records its end just after its run ends: while one runs, read again now and then.
  const anyRunning = fires?.some((f) => f.status === "running") === true;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

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
    api.routines.run(routine.id).then(
      () => {
        toast(`“${routine.name}” começou a rodar. O resultado chega no chat.`, "info");
        load();
      },
      (e: unknown) => toast(messageOf(e), "error"),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="routine-detail">
      <div className="flex flex-none items-center gap-1 px-3 pt-3 pb-2">
        <RoundButton label="Voltar às rotinas" tone="ghost" onClick={back}>
          <ArrowLeft size={18} aria-hidden="true" />
        </RoundButton>
        <span className="flex-1" />
        {routine !== undefined && (
          <>
            <RoundButton
              label={paused ? "Retomar a rotina" : "Pausar a rotina"}
              tone="ghost"
              disabled={routine.status === "ended"}
              onClick={togglePause}
              data-testid="routine-pause"
            >
              {paused ? (
                <Play size={18} aria-hidden="true" />
              ) : (
                <Pause size={18} aria-hidden="true" />
              )}
            </RoundButton>
            <RoundButton
              label="Rodar agora, uma vez, fora do horário"
              tone="ghost"
              disabled={anyRunning}
              onClick={runNow}
              data-testid="routine-run"
            >
              <Zap size={18} aria-hidden="true" />
            </RoundButton>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        {error !== undefined && <FieldError>{error}</FieldError>}
        {routine !== undefined && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1 px-2">
              <h2 className="text-title font-title wrap-anywhere">{routine.name}</h2>
              <MutedText data-testid="routine-schedule">
                {describeSchedule(routine.schedule)}
              </MutedText>
              <MutedText data-testid="routine-next">{nextText(routine)}</MutedText>
            </div>
            <section aria-label="O que o bot escreveu" className="flex flex-col gap-2">
              <h3 className="px-2 text-label font-normal text-text-muted">Resultados</h3>
              {fires !== undefined && fires.length === 0 && (
                <MutedText as="p" className="px-2">
                  Ainda não rodou. O resultado de cada vez aparece aqui e no chat.
                </MutedText>
              )}
              {fires !== undefined && fires.length > 0 && (
                <ul
                  className="flex flex-col overflow-hidden rounded-card border border-border bg-surface [&>*+*]:border-t [&>*+*]:border-border"
                  data-testid="routine-fires"
                >
                  {fires.map((f) => (
                    <FireItem key={f.id} fire={f} routine={routine} />
                  ))}
                </ul>
              )}
              {fires !== undefined && fires.length === limit && limit < FIRES_MAX && (
                <Pill
                  tone="quiet"
                  size="sm"
                  className="self-center"
                  onClick={() => setLimit((n) => Math.min(n + FIRES_PAGE, FIRES_MAX))}
                  data-testid="routine-more"
                >
                  Mostrar mais
                </Pill>
              )}
            </section>
            <div className="flex justify-end gap-2" data-testid="routine-actions">
              <Pill
                size="sm"
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
                size="sm"
                tone="danger"
                onClick={() => setRemoving(true)}
                data-testid="routine-remove"
              >
                Remover
              </Pill>
            </div>
          </div>
        )}
      </div>
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
