import type { Routine } from "@suup/api";
import { CalendarClock, MonitorSmartphone, MoreHorizontal, Pause } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { describeSchedule, lastText, nextText } from "../../lib/routines.js";
import { MenuButton, type MenuItem } from "../../ui/menu.js";
import { MutedText, RoundButton } from "../../ui/primitives.js";
import { RoutineDeleteDialog, RoutineEditDialog, RoutineHistoryDialog } from "./RoutineDialogs.js";

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

type Opened = { kind: "edit" | "history" | "delete"; routine: Routine } | null;

/** One routine: its name, when in words, the next run, the last result, and its actions in a menu. */
function RoutineRow({
  routine,
  busy,
  onAction,
}: {
  routine: Routine;
  busy: boolean;
  onAction(action: "edit" | "history" | "delete" | "pause" | "resume" | "run"): void;
}) {
  const paused = routine.status === "paused";
  const last = lastText(routine);
  const items: MenuItem[] = [
    { id: "edit", label: "Editar", onSelect: () => onAction("edit") },
    paused
      ? { id: "resume", label: "Retomar", onSelect: () => onAction("resume") }
      : {
          id: "pause",
          label: "Pausar",
          disabled: routine.status === "ended",
          onSelect: () => onAction("pause"),
        },
    {
      id: "run",
      label: "Rodar agora",
      description: "Uma vez, fora do horário.",
      disabled: busy,
      onSelect: () => onAction("run"),
    },
    { id: "history", label: "Histórico", onSelect: () => onAction("history") },
    { id: "delete", label: "Apagar", danger: true, onSelect: () => onAction("delete") },
  ];
  return (
    <div
      className="flex min-w-0 items-start gap-3 px-4 py-3"
      data-testid="routine-row"
      data-routine={routine.name}
      data-status={routine.status}
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
      <MenuButton
        label={`Ações da rotina ${routine.name}`}
        items={items}
        trigger={(props) => (
          <RoundButton label={`Ações da rotina ${routine.name}`} tone="ghost" size="sm" {...props}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </RoundButton>
        )}
      />
    </div>
  );
}

/**
 * The routines of a bot (docs/ROTINAS.md), in the Atividade tab. They are created by talking to the
 * bot; here the user sees each one in words, pauses or resumes it, runs it now, edits WHEN with the
 * structured fields, reads its history and deletes it. Read from `/v1/routines`, and again whenever a
 * run of this bot changes status (the stream brings the runs).
 */
function RoutinesSection({ botId }: { botId: string }) {
  const { api } = useServices();
  const toast = useUi((s) => s.toast);
  const [routines, setRoutines] = useState<Routine[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [opened, setOpened] = useState<Opened>(null);
  // A mark that moves whenever a run of this bot changes status (a routine's run, or a chat run that
  // created or changed one): the list is read again.
  const runs = useData((s) => s.runs);
  const mark = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.botId === botId)
        .map((r) => `${r.id}:${r.status}`)
        .sort()
        .join(","),
    [runs, botId],
  );
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

  const replace = (saved: Routine) =>
    setRoutines((list) => list?.map((r) => (r.id === saved.id ? saved : r)));
  const act = (
    routine: Routine,
    action: "edit" | "history" | "delete" | "pause" | "resume" | "run",
  ) => {
    if (action === "edit" || action === "history" || action === "delete") {
      setOpened({ kind: action, routine });
      return;
    }
    if (action === "run") {
      api.routines.run(routine.id).then(
        () => {
          toast(`“${routine.name}” começou a rodar. O resultado chega no chat.`, "info");
          load();
        },
        (e: unknown) => toast(messageOf(e), "error"),
      );
      return;
    }
    api.routines
      .update(routine.id, { paused: action === "pause" })
      .then(replace, (e: unknown) => toast(messageOf(e), "error"));
  };

  const running = (routine: Routine) => routine.lastFire?.status === "running";
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
        <RoutineRow
          key={r.id}
          routine={r}
          busy={running(r)}
          onAction={(action) => act(r, action)}
        />
      ))}
      {opened?.kind === "edit" && (
        <RoutineEditDialog
          routine={opened.routine}
          onClose={() => setOpened(null)}
          onSaved={(saved) => {
            replace(saved);
            setOpened(null);
          }}
        />
      )}
      {opened?.kind === "history" && (
        <RoutineHistoryDialog routine={opened.routine} onClose={() => setOpened(null)} />
      )}
      {opened?.kind === "delete" && (
        <RoutineDeleteDialog
          routine={opened.routine}
          onClose={() => setOpened(null)}
          onDeleted={() => {
            setRoutines((list) => list?.filter((r) => r.id !== opened.routine.id));
            setOpened(null);
          }}
        />
      )}
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
