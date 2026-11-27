import type { ModelInfo, Routine } from "@suup/api";
import { ChevronDown, Clock, MonitorSmartphone } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { describeSchedule } from "../../lib/routines.js";
import { Dropdown } from "../../ui/dropdown.js";
import { MutedText, Toggle } from "../../ui/primitives.js";
import { useBotRunMark } from "./run-mark.js";

/**
 * A titled box of the panel: a muted title, then its rows in a card. `flush`: rows edge to edge.
 * The rows of a panel card have NO rule between them (owner's decision, 22/11/2026, as in the Grok
 * Bot): docs/DESIGN.md §5b and `design-rules.test.ts` keep it so.
 */
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
      <h3 className="px-1 pb-2 text-small font-normal text-text-muted">{title}</h3>
      <div
        className={cx(
          "rounded-card border border-border bg-surface",
          flush === true ? "overflow-hidden" : "p-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** One row of a panel box: an optional icon, a title with a line under it, an optional thumbnail. */
export function PanelRow({
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
          className="inline-flex h-10 w-17.5 items-center justify-center rounded-inner bg-raised text-text-muted"
          aria-hidden="true"
        >
          {thumb}
        </span>
      )}
    </div>
  );
}

/** One routine: its name, when in words, the next run, the last result. The row opens its detail. */
function RoutineRow({
  routine,
  onOpen,
  onToggle,
}: {
  routine: Routine;
  onOpen(): void;
  onToggle(paused: boolean): void;
}) {
  const paused = routine.status === "paused";
  // One paragraph under the title (as in the Grok Bot): when it runs, or "Pausada" / "Encerrada".
  // The next run and the last result are in the detail.
  const paragraph =
    routine.status === "paused"
      ? "Pausada"
      : routine.status === "ended"
        ? "Encerrada"
        : describeSchedule(routine.schedule);
  return (
    <div className="flex w-full min-w-0 items-center gap-3 pr-3 hover:bg-hover">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent py-2.5 pl-3 text-left text-text"
        data-testid="routine-row"
        data-routine={routine.name}
        data-status={routine.status}
        aria-label={`Abrir a rotina ${routine.name}`}
        onClick={onOpen}
      >
        <span className="inline-flex text-text-muted" aria-hidden="true">
          <Clock size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-label font-label wrap-anywhere">{routine.name}</span>
          <MutedText data-testid="routine-schedule">{paragraph}</MutedText>
        </span>
      </button>
      {/* The switch is the same pause and resume of the detail: on = the routine runs. */}
      <Toggle
        accent
        checked={!paused}
        disabled={routine.status === "ended"}
        label={`Rotina ativa: ${routine.name}`}
        testId="routine-toggle"
        onChange={(next) => onToggle(!next)}
      />
    </div>
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
  const toast = useUi((s) => s.toast);
  // The switch of a row: the same call as the pause button of the detail; the server answers with
  // the routine, which replaces the row (nothing is optimistic).
  const togglePause = (routine: Routine, paused: boolean) => {
    api.routines.update(routine.id, { paused }).then(
      (updated) => setRoutines((list) => list?.map((r) => (r.id === updated.id ? updated : r))),
      (e: unknown) => toast(messageOf(e), "error"),
    );
  };

  return (
    <PanelSection title="Rotinas" label="Rotinas" testId="section-routines" flush>
      {error !== undefined && (
        <PanelRow icon={<Clock size={16} />} title="Não foi possível ler as rotinas" text={error} />
      )}
      {routines !== undefined && routines.length === 0 && error === undefined && (
        <PanelRow
          icon={<Clock size={16} />}
          title="Nenhuma rotina"
          text="Peça no chat, por exemplo: “vê meu calendário todo dia às 8h”."
        />
      )}
      {routines?.map((r) => (
        <RoutineRow
          key={r.id}
          routine={r}
          onOpen={() => openPanelRoutine(r.id)}
          onToggle={(paused) => togglePause(r, paused)}
        />
      ))}
    </PanelSection>
  );
}

/** The model that answers this bot's chat, with the app's dropdown: a real control (it changes the bot). */
function ChatModelRow({ botId }: { botId: string }) {
  const { api, sync } = useServices();
  const bot = useData((s) => s.bots[botId]);
  const toast = useUi((s) => s.toast);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    api.models.list().then(setModels, () => undefined);
  }, [api]);
  if (bot === undefined) return null;
  const usable = models.filter((m) => m.available || m.id === bot.modelId);
  const change = (modelId: string) => {
    api.bots.update(bot.id, { modelId }).then(
      (updated) => sync.mergeBotNow(updated),
      (e: unknown) => toast(messageOf(e), "error"),
    );
  };
  return (
    <div className="flex min-w-0 items-center gap-3 py-1 pr-1 pl-3">
      <span className="min-w-0 flex-1 text-label">Modelo de chat</span>
      <Dropdown
        label="Modelo de chat"
        value={bot.modelId}
        options={
          usable.length > 0
            ? usable.map((m) => ({ value: m.id, label: m.name }))
            : [{ value: bot.modelId, label: bot.modelId }]
        }
        onChange={change}
        testId="chat-model"
      />
    </div>
  );
}

/** A row of the voice ornament: a name and a muted value with a chevron. It does nothing. */
function OrnamentRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1 text-label">{title}</span>
      <MutedText>{value}</MutedText>
      <ChevronDown size={14} className="text-text-muted" aria-hidden="true" />
    </div>
  );
}

/**
 * The Atividade tab: the bot's routines, its computer (which waits for its phase), and "Chat e voz":
 * the chat model, which is real (it changes the bot), and the voice and its language, which the
 * backend does not have yet: they are an ornament (owner's decision, 22/11/2026), hidden from
 * assistive technology, dimmed, "Em breve", and with nothing to click.
 */
export function ActivityTab({ botId }: { botId: string }) {
  return (
    <div className="flex flex-col gap-8">
      <RoutinesSection botId={botId} />
      <PanelSection title="Computador" label="Computador" testId="section-computer" flush>
        <PanelRow
          title="Computador do bot"
          text="Ainda não disponível"
          thumb={<MonitorSmartphone size={22} />}
        />
      </PanelSection>
      <PanelSection title="Chat e voz" label="Chat e voz" testId="section-voice" flush>
        <ChatModelRow botId={botId} />
        <div aria-hidden="true" className="opacity-60" data-testid="ornament-voice">
          <OrnamentRow title="Voz" value="Em breve" />
          <OrnamentRow title="Idioma" value="Em breve" />
        </div>
      </PanelSection>
    </div>
  );
}
