import type { Routine } from "@suup/api";
import { CalendarClock, ChevronRight, MonitorSmartphone, Pause } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { describeSchedule, lastText, nextText } from "../../lib/routines.js";
import { MutedText } from "../../ui/primitives.js";
import { useBotRunMark } from "./run-mark.js";

/** A titled box of the panel: a muted title, then its rows in a card. `flush`: rows edge to edge. */
function PanelSection({
  title,
  label,
  testId,
  flush,
  children,
}: {
  title: string;
  label: string;
  testId: string;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} data-testid={testId}>
      <h3 className="px-2 pb-2 text-label font-normal text-text-muted">{title}</h3>
      <div
        className={cx(
          "rounded-card border border-border bg-surface",
          flush === true ? "overflow-hidden [&>*+*]:border-t [&>*+*]:border-border" : "p-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** One row of a panel box: an optional icon, a title with a line under it, an optional thumbnail. */
function PanelRow({
  icon,
  title,
  text,
  thumb,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  thumb?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 p-3">
      {icon !== undefined && (
        <span className="inline-flex text-text-muted" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label">{title}</span>
        <MutedText>{text}</MutedText>
      </span>
      {thumb !== undefined && (
        <span
          className="inline-flex h-12 w-20 items-center justify-center rounded-inner bg-raised text-text-muted"
          aria-hidden="true"
        >
          {thumb}
        </span>
      )}
    </div>
  );
}

/** One routine: its name, when in words, the next run, the last result. The row opens its detail. */
function RoutineRow({ routine, onOpen }: { routine: Routine; onOpen(): void }) {
  const paused = routine.status === "paused";
  const last = lastText(routine);
  return (
    <button
      type="button"
      className="group/row flex w-full min-w-0 items-start gap-3 border-0 bg-transparent px-4 py-3 text-left text-text hover:bg-hover"
      data-testid="routine-row"
      data-routine={routine.name}
      data-status={routine.status}
      aria-label={`Abrir a rotina ${routine.name}`}
      onClick={onOpen}
    >
      <span className="inline-flex pt-0.5 text-text-muted" aria-hidden="true">
        {paused ? <Pause size={16} /> : <CalendarClock size={16} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label font-label wrap-anywhere">{routine.name}</span>
        <MutedText data-testid="routine-schedule">{describeSchedule(routine.schedule)}</MutedText>
        <MutedText data-testid="routine-next">{nextText(routine)}</MutedText>
        {last !== null && <MutedText data-testid="routine-last">{last}</MutedText>}
      </span>
      <span
        className="inline-flex self-center text-text-muted opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
        aria-hidden="true"
      >
        <ChevronRight size={16} />
      </span>
    </button>
  );
}

/**
 * The routines of a bot (docs/ROTINAS.md), in the Atividade tab. They are created and changed by
 * talking to the bot; here the user sees each one in words, and a row opens its detail (results,
 * pause, run now, Editar in the chat, Remover). Read from `/v1/routines`, and again whenever a run
 * of this bot changes status (the stream brings the runs).
 */
function RoutinesSection({ botId }: { botId: string }) {
  const { api } = useServices();
  const openPanelRoutine = useUi((s) => s.openPanelRoutine);
  const [routines, setRoutines] = useState<Routine[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const mark = useBotRunMark(botId);
  const load = useCallback(() => {
    api.routines.list({ botId }).then(
      (items) => {
        setRoutines(items);
        setError(undefined);
      },
      (e: unknown) => setError(messageOf(e)),
    );
  }, [api, botId]);
  // `mark` changes when a run of this bot changes: the list is read again.
  useEffect(() => {
    if (mark !== null) load();
  }, [load, mark]);
  // A fire records its end just after its run ends (the result goes to the chat first): while one
  // is running, the list is read again now and then.
  const anyRunning = routines?.some((r) => r.lastFire?.status === "running") === true;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  return (
    <PanelSection title="Rotinas" label="Rotinas" testId="section-routines" flush>
      {error !== undefined && (
        <PanelRow
          icon={<CalendarClock size={16} />}
          title="Não foi possível ler as rotinas"
          text={error}
        />
      )}
      {routines !== undefined && routines.length === 0 && error === undefined && (
        <PanelRow
          icon={<CalendarClock size={16} />}
          title="Nenhuma rotina"
          text="Peça no chat, por exemplo: “vê meu calendário todo dia às 8h”."
        />
      )}
      {routines?.map((r) => (
        <RoutineRow key={r.id} routine={r} onOpen={() => openPanelRoutine(r.id)} />
      ))}
    </PanelSection>
  );
}

/** The Atividade tab: the bot's routines, and its computer (which waits for its phase). */
export function ActivityTab({ botId }: { botId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <RoutinesSection botId={botId} />
      <PanelSection title="Computador" label="Computador" testId="section-computer">
        <PanelRow
          title="Computador do bot"
          text="Ainda não disponível"
          thumb={<MonitorSmartphone size={22} />}
        />
      </PanelSection>
    </div>
  );
}
