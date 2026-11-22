import {
  describeSchedule,
  type Routine,
  type RoutineFire,
  type Schedule,
  type ScheduleKind,
  scheduleSchema,
  type Weekday,
  wallClockAt,
} from "@suup/api";

// What the Rotinas panel SAYS (docs/ROTINAS.md, docs/DESIGN.md): the schedule in words (the shared
// function the server and the bot use too), when it runs next, and each fire of the history. And the
// form of the schedule: structured fields only, never cron text. Pure functions, table-tested.

const pad = (n: number): string => String(n).padStart(2, "0");

/** `hoje, 08:00`, `amanhã, 08:00`, `seg., 24/11, 08:00`, in the routine's zone. */
export function whenText(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const w = wallClockAt(at, timeZone);
  const today = wallClockAt(now, timeZone);
  const day = (c: { year: number; month: number; day: number }) =>
    Date.UTC(c.year, c.month - 1, c.day) / 86_400_000;
  const delta = day(w) - day(today);
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  if (delta === 0) return `hoje, ${time}`;
  if (delta === 1) return `amanhã, ${time}`;
  if (delta === -1) return `ontem, ${time}`;
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone }).format(at);
  const year = w.year === today.year ? "" : `/${w.year}`;
  return `${weekday}, ${pad(w.day)}/${pad(w.month)}${year}, ${time}`;
}

/** The line under the name: when it runs next, or that it is paused or over. */
export function nextText(routine: Routine, now: Date = new Date()): string {
  if (routine.status === "paused") return "Pausada";
  if (routine.status === "ended") return "Encerrada";
  return routine.nextRunAt === null
    ? "Sem próximo horário"
    : `Próxima: ${whenText(routine.nextRunAt, routine.timeZone, now)}`;
}

const FIRE_STATUS: Record<RoutineFire["status"], string> = {
  running: "Rodando",
  done: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
  skipped: "Pulada: a anterior ainda rodava",
};

/** `Concluída`, `Falhou`, `Pulada: a anterior ainda rodava`... */
export const fireStatusText = (fire: RoutineFire): string => FIRE_STATUS[fire.status];

/** What kind of fire it was, when it was not just on time: `Recuperação · 3 perdidas`, `Rodar agora`. */
export function fireKindText(fire: RoutineFire): string | null {
  if (fire.kind === "manual") return "Rodar agora";
  if (fire.kind === "catch_up") {
    return fire.missedCount === 0
      ? "Recuperação (atrasada)"
      : `Recuperação · ${fire.missedCount} ${fire.missedCount === 1 ? "perdida" : "perdidas"}`;
  }
  return fire.missedCount === 0
    ? null
    : `${fire.missedCount} ${fire.missedCount === 1 ? "perdida" : "perdidas"}`;
}

/** The last result in one line: `Última: hoje, 08:00 · Concluída`. */
export function lastText(routine: Routine, now: Date = new Date()): string | null {
  const fire = routine.lastFire;
  if (fire === null) return null;
  const kind = fireKindText(fire);
  return `Última: ${whenText(fire.scheduledFor, routine.timeZone, now)} · ${fireStatusText(fire)}${kind === null ? "" : ` · ${kind}`}`;
}

export { describeSchedule };

// ---------------------------------------------------------------------------------------------
// The form of a schedule

export const KIND_LABEL: Record<ScheduleKind, string> = {
  daily: "Todo dia",
  weekly: "Toda semana",
  monthly: "Todo mês",
  interval: "A cada…",
  once: "Uma vez",
};
export const KIND_ORDER: readonly ScheduleKind[] = [
  "daily",
  "weekly",
  "monthly",
  "interval",
  "once",
];

/** Everything the form can hold; `toSchedule` reads only the fields of the chosen kind. */
export interface ScheduleDraft {
  kind: ScheduleKind;
  /** `HH:MM`. */
  time: string;
  /** `AAAA-MM-DD`, for `once`. */
  date: string;
  days: Weekday[];
  day: number;
  every: number;
  unit: "minutes" | "hours";
  /** `AAAA-MM-DD` or empty: the routine has no end date. */
  until: string;
}

export function draftOf(schedule: Schedule): ScheduleDraft {
  const base: ScheduleDraft = {
    kind: schedule.kind,
    time: "08:00",
    date: "",
    days: ["mon"],
    day: 1,
    every: 30,
    unit: "minutes",
    until: "",
  };
  switch (schedule.kind) {
    case "once":
      return { ...base, date: schedule.date, time: schedule.time };
    case "daily":
      return { ...base, time: schedule.time, until: schedule.until ?? "" };
    case "weekly":
      return {
        ...base,
        days: [...schedule.days],
        time: schedule.time,
        until: schedule.until ?? "",
      };
    case "monthly":
      return { ...base, day: schedule.day, time: schedule.time, until: schedule.until ?? "" };
    case "interval":
      return {
        ...base,
        every: schedule.every,
        unit: schedule.unit,
        until: schedule.until ?? "",
      };
  }
}

/** The schedule the form says, or the first problem, in words (the server checks it again). */
export function toSchedule(draft: ScheduleDraft): { schedule: Schedule } | { error: string } {
  const until = draft.until.trim() === "" ? {} : { until: draft.until.trim() };
  const raw =
    draft.kind === "once"
      ? { kind: "once", date: draft.date, time: draft.time }
      : draft.kind === "daily"
        ? { kind: "daily", time: draft.time, ...until }
        : draft.kind === "weekly"
          ? { kind: "weekly", days: draft.days, time: draft.time, ...until }
          : draft.kind === "monthly"
            ? { kind: "monthly", day: draft.day, time: draft.time, ...until }
            : { kind: "interval", every: draft.every, unit: draft.unit, ...until };
  const parsed = scheduleSchema.safeParse(raw);
  if (parsed.success) return { schedule: parsed.data };
  const [first] = parsed.error.issues;
  const field = String(first?.path[0] ?? "");
  const what: Record<string, string> = {
    days: "Escolha pelo menos um dia.",
    date: "Escolha a data.",
    until: "A data de fim não é válida.",
    time: "Escolha o horário.",
    day: "O dia do mês vai de 1 a 31.",
  };
  return { error: what[field] ?? first?.message ?? "Horário inválido." };
}

/** Hours and minutes for the two dropdowns of a time (every 5 minutes, plus the current one). */
export const HOURS: readonly string[] = Array.from({ length: 24 }, (_, i) => pad(i));
export function minutesWith(current: string): string[] {
  const list = Array.from({ length: 12 }, (_, i) => pad(i * 5));
  return list.includes(current) ? list : [...list, current].sort();
}

/** The IANA zones this runtime knows, with `current` first in the list if it is not among them. */
export function timeZones(current: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = [];
  }
  return all.includes(current) ? all : [current, ...all];
}
