import type { Routine, RoutineFire, ScheduleKind, Weekday } from "@suup/api";
import { WEEKDAY_LABELS } from "@suup/api";
import { useEffect, useMemo, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { messageOf } from "../../data/sync.js";
import {
  describeSchedule,
  draftOf,
  fireKindText,
  fireStatusText,
  HOURS,
  KIND_LABEL,
  KIND_ORDER,
  minutesWith,
  type ScheduleDraft,
  timeZones,
  toSchedule,
  whenText,
} from "../../lib/routines.js";
import { ToggleChip } from "../../ui/choice.js";
import { Dropdown } from "../../ui/dropdown.js";
import { NumberField } from "../../ui/number-field.js";
import {
  Dialog,
  FieldError,
  FieldLabel,
  FormRow,
  FormStack,
  MutedText,
  Pill,
  TextField,
} from "../../ui/primitives.js";

/** The two dropdowns of a time of day (hour and minute): never a free text, never cron. */
function TimeFields({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [hour = "08", minute = "00"] = value.split(":");
  return (
    <FormRow as="fieldset">
      <FieldLabel as="legend">Horário</FieldLabel>
      <div className="flex items-center gap-2">
        <Dropdown
          label="Hora"
          variant="field"
          value={hour}
          options={HOURS.map((h) => ({ value: h, label: h }))}
          onChange={(h) => onChange(`${h}:${minute}`)}
          testId="routine-hour"
        />
        <span aria-hidden="true">:</span>
        <Dropdown
          label="Minuto"
          variant="field"
          value={minute}
          options={minutesWith(minute).map((m) => ({ value: m, label: m }))}
          onChange={(m) => onChange(`${hour}:${m}`)}
          testId="routine-minute"
        />
      </div>
    </FormRow>
  );
}

/**
 * Editing a routine (docs/ROTINAS.md): its name, its instruction and WHEN, with the same structured
 * fields the bot fills in (the kind, the time in two dropdowns, the days, the day of the month, the
 * interval, an optional end date, the time zone). The schedule in words is shown as it is typed; the
 * server checks it again and computes the next run.
 */
export function RoutineEditDialog({
  routine,
  onClose,
  onSaved,
}: {
  routine: Routine;
  onClose(): void;
  onSaved(routine: Routine): void;
}) {
  const { api } = useServices();
  const [name, setName] = useState(routine.name);
  const [instruction, setInstruction] = useState(routine.instruction);
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftOf(routine.schedule));
  const [zone, setZone] = useState(routine.timeZone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const read = toSchedule(draft);
  const zones = useMemo(() => timeZones(routine.timeZone), [routine.timeZone]);
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const toggleDay = (day: Weekday) =>
    set({
      days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day],
    });
  const save = () => {
    if ("error" in read || name.trim() === "" || instruction.trim() === "") return;
    setSaving(true);
    setError(undefined);
    api.routines
      .update(routine.id, {
        name: name.trim(),
        instruction: instruction.trim(),
        schedule: read.schedule,
        timeZone: zone,
      })
      .then(
        (saved) => {
          setSaving(false);
          onSaved(saved);
        },
        (e: unknown) => {
          setSaving(false);
          setError(messageOf(e));
        },
      );
  };
  return (
    <Dialog
      title="Editar rotina"
      onClose={onClose}
      footer={
        <>
          <Pill tone="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={save}
            disabled={saving || "error" in read || name.trim() === "" || instruction.trim() === ""}
            aria-busy={saving}
            data-testid="routine-save"
          >
            {saving ? "Salvando…" : "Salvar"}
          </Pill>
        </>
      }
    >
      <FormStack data-testid="routine-form">
        <TextField label="Nome" value={name} onChange={setName} />
        <TextField
          label="O que fazer a cada vez"
          value={instruction}
          onChange={setInstruction}
          multiline
          rows={3}
          hint="Cada vez é uma execução nova, sem esta conversa: escreva a instrução completa."
        />
        <FormRow>
          <FieldLabel as="span">Quando</FieldLabel>
          <Dropdown<ScheduleKind>
            label="Quando"
            variant="field"
            value={draft.kind}
            options={KIND_ORDER.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            onChange={(kind) => set({ kind })}
            testId="routine-kind"
          />
        </FormRow>
        {draft.kind === "weekly" && (
          <FormRow as="fieldset">
            <FieldLabel as="legend">Dias</FieldLabel>
            <div className="flex flex-wrap gap-2" data-testid="routine-days">
              {WEEKDAY_LABELS.map((d) => (
                <ToggleChip
                  key={d.day}
                  on={draft.days.includes(d.day)}
                  onClick={() => toggleDay(d.day)}
                  aria-label={d.label}
                >
                  {d.short}
                </ToggleChip>
              ))}
            </div>
          </FormRow>
        )}
        {draft.kind === "monthly" && (
          <FormRow>
            <FieldLabel as="span">Dia do mês</FieldLabel>
            <div className="flex items-center gap-2">
              <NumberField
                label="Dia do mês"
                value={draft.day}
                onCommit={(day) => set({ day })}
                testId="routine-day"
              />
              <MutedText>Num mês sem esse dia, roda no último dia.</MutedText>
            </div>
          </FormRow>
        )}
        {draft.kind === "interval" && (
          <FormRow>
            <FieldLabel as="span">A cada</FieldLabel>
            <div className="flex items-center gap-2">
              <NumberField
                label="A cada"
                value={draft.every}
                onCommit={(every) => set({ every })}
                testId="routine-every"
              />
              <Dropdown<"minutes" | "hours">
                label="Unidade"
                variant="field"
                value={draft.unit}
                options={[
                  { value: "minutes", label: "minutos" },
                  { value: "hours", label: "horas" },
                ]}
                onChange={(unit) => set({ unit })}
                testId="routine-unit"
              />
            </div>
          </FormRow>
        )}
        {draft.kind === "once" && (
          <TextField
            label="Data"
            value={draft.date}
            placeholder="AAAA-MM-DD"
            onChange={(date) => set({ date })}
          />
        )}
        {draft.kind !== "interval" && (
          <TimeFields value={draft.time} onChange={(time) => set({ time })} />
        )}
        {draft.kind !== "once" && (
          <TextField
            label="Termina em (opcional)"
            value={draft.until}
            placeholder="AAAA-MM-DD"
            onChange={(until) => set({ until })}
          />
        )}
        <FormRow>
          <FieldLabel as="span">Fuso horário</FieldLabel>
          <Dropdown
            label="Fuso horário"
            variant="field"
            value={zone}
            options={zones.map((z) => ({ value: z, label: z }))}
            onChange={setZone}
            testId="routine-zone"
          />
        </FormRow>
        {"error" in read ? (
          <FieldError data-testid="routine-form-error">{read.error}</FieldError>
        ) : (
          <MutedText as="p" data-testid="routine-preview">
            {describeSchedule(read.schedule)} · {zone}. Num dia de mudança de horário, uma hora que
            não existe roda logo depois, e uma que se repete roda uma vez só.
          </MutedText>
        )}
        {error !== undefined && <FieldError>{error}</FieldError>}
      </FormStack>
    </Dialog>
  );
}

/** One fire of the history: when, how it went, what it said, and the way to the run. */
function FireRow({ fire, routine }: { fire: RoutineFire; routine: Routine }) {
  const openInspector = useUi((s) => s.openInspector);
  const kind = fireKindText(fire);
  return (
    <li className="flex flex-col gap-1 py-3" data-testid="routine-fire" data-status={fire.status}>
      <span className="flex items-center justify-between gap-3">
        <span className="text-label font-label">
          {whenText(fire.scheduledFor, routine.timeZone)}
        </span>
        {fire.runId !== null && (
          <Pill tone="quiet" size="sm" onClick={() => openInspector(fire.runId as string)}>
            Ver a execução
          </Pill>
        )}
      </span>
      <MutedText>
        {fireStatusText(fire)}
        {kind === null ? "" : ` · ${kind}`}
      </MutedText>
      {fire.resultText !== null && fire.resultText !== "" && (
        <MutedText as="p" className="line-clamp-3 wrap-anywhere">
          {fire.resultText}
        </MutedText>
      )}
    </li>
  );
}

/** The history of a routine (`GET /v1/routines/{id}/fires`), newest first. */
export function RoutineHistoryDialog({ routine, onClose }: { routine: Routine; onClose(): void }) {
  const { api } = useServices();
  const [fires, setFires] = useState<RoutineFire[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.routines
      .fires(routine.id, { limit: 50 })
      .then(setFires, (e: unknown) => setError(messageOf(e)));
  }, [api, routine.id]);
  return (
    <Dialog title={`Histórico · ${routine.name}`} onClose={onClose}>
      {error !== undefined && <FieldError>{error}</FieldError>}
      {fires !== undefined && fires.length === 0 && <MutedText as="p">Ainda não rodou.</MutedText>}
      {fires !== undefined && fires.length > 0 && (
        <ul
          className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border"
          data-testid="routine-fires"
        >
          {fires.map((f) => (
            <FireRow key={f.id} fire={f} routine={routine} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** "Apagar" asks once: the routine and its history go, the runs stay. */
export function RoutineDeleteDialog({
  routine,
  onClose,
  onDeleted,
}: {
  routine: Routine;
  onClose(): void;
  onDeleted(): void;
}) {
  const { api } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = () => {
    setBusy(true);
    api.routines.delete(routine.id).then(onDeleted, (e: unknown) => {
      setBusy(false);
      setError(messageOf(e));
    });
  };
  return (
    <Dialog
      title="Apagar a rotina?"
      onClose={onClose}
      footer={
        <>
          <Pill tone="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Pill>
          <Pill tone="danger" onClick={remove} disabled={busy} data-testid="routine-delete-confirm">
            {busy ? "Apagando…" : "Apagar"}
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
