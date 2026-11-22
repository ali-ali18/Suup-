import { describeSchedule, type Routine, type RoutineFire, wallClockAt } from "@suup/api";

// What the Rotinas panel SAYS (docs/ROTINAS.md, docs/DESIGN.md): the schedule in words (the shared
// function the server and the bot use too), when it runs next, each fire of the history, and the
// draft "Editar" leaves in the chat (the app has no schedule form: routines change by asking the
// bot). Pure functions, table-tested.

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

/**
 * The draft "Editar" puts in the composer of the bot's chat (docs/ROTINAS.md): which routine, and
 * when it runs in words, for the person to finish with what to change. The routine itself goes
 * with the message as data (`routineRef`), never its id in the text.
 */
export function editDraft(routine: Pick<Routine, "name" | "schedule">): string {
  return `Editar a rotina “${routine.name}” (${describeSchedule(routine.schedule)}): `;
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
