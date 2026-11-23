// The schedule of a routine (docs/ROTINAS.md): STRUCTURED fields, never cron text, and the math
// that says when it fires next, in an IANA time zone, with the daylight-saving policy of the research
// (docs/pesquisas/fase-4-rotinas-webhooks-notificacoes.md, croner and GitHub Actions semantics):
//
//   * a wall time that does not exist (the clock jumps forward) fires at the first valid instant
//     after the gap: 02:30 on the day the clock goes 02:00 -> 03:00 fires at 03:00;
//   * a wall time that happens twice (the clock goes back) fires once, at the first occurrence;
//   * an interval is an absolute duration ("every 30 minutes" is every 30 real minutes, through any
//     change of the clock), aligned to its anchor (the moment the schedule was set);
//   * a monthly day the month does not have (31 in April, 29 in a February that is not leap) fires on
//     the last day of that month.
//
// Pure: no Node module (the desktop app imports it through `@suup/api`), no cron library and no
// pattern. The offsets come from `Intl.DateTimeFormat`; dates and times are read character by
// character (a formal format of fixed grammar).
import { z } from "zod";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const SCHEDULE_KINDS = ["once", "daily", "weekly", "monthly", "interval"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const INTERVAL_UNITS = ["minutes", "hours"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

/** The shortest interval a routine may have, in minutes (the research: GitHub Actions and others). */
export const MIN_INTERVAL_MINUTES = 5;
/** The longest interval, in minutes (31 days): anything rarer is a monthly routine. */
export const MAX_INTERVAL_MINUTES = 31 * 24 * 60;

const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch.length === 1 && ch >= "0" && ch <= "9";

/** `HH:MM` (24 h) read character by character; `null` when it is not one. */
export function parseLocalTime(text: string): { hour: number; minute: number } | null {
  if (text.length !== 5 || text[2] !== ":") return null;
  if (![0, 1, 3, 4].every((i) => isDigit(text[i]))) return null;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(3, 5));
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in a month (1 to 12) of a year of the Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `AAAA-MM-DD` read character by character; `null` when it is not a real date. */
export function parseLocalDate(text: string): LocalDate | null {
  if (text.length !== 10 || text[4] !== "-" || text[7] !== "-") return null;
  if (![0, 1, 2, 3, 5, 6, 8, 9].every((i) => isDigit(text[i]))) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatLocalDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** True for a name the time zone database of this runtime knows (`Intl` is the judge). */
export function isKnownTimeZone(name: string): boolean {
  if (name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const localTime = z
  .string()
  .refine((t) => parseLocalTime(t) !== null, "horário no formato HH:MM, de 00:00 a 23:59")
  .describe("Local time, HH:MM (24 h), e.g. 08:00.");
const localDate = z
  .string()
  .refine((d) => parseLocalDate(d) !== null, "data no formato AAAA-MM-DD")
  .describe("Local date, YYYY-MM-DD.");
const until = z
  .exactOptional(localDate)
  .describe("Optional last local date (YYYY-MM-DD, inclusive). After it, the routine ends.");

export const onceScheduleSchema = z.object({
  kind: z.literal("once"),
  date: localDate,
  time: localTime,
});
export const dailyScheduleSchema = z.object({ kind: z.literal("daily"), time: localTime, until });
export const weeklyScheduleSchema = z.object({
  kind: z.literal("weekly"),
  days: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "um dia repetido")
    .describe("Days of the week: sun, mon, tue, wed, thu, fri, sat."),
  time: localTime,
  until,
});
export const monthlyScheduleSchema = z.object({
  kind: z.literal("monthly"),
  day: z
    .number()
    .int()
    .min(1)
    .max(31)
    .describe("Day of the month, 1 to 31. A month without that day runs on its last day."),
  time: localTime,
  until,
});
export const intervalScheduleSchema = z
  .object({
    kind: z.literal("interval"),
    every: z.number().int().min(1).describe("How many units between runs."),
    unit: z.enum(INTERVAL_UNITS),
    until,
  })
  .refine(
    (s) => intervalMinutes(s) >= MIN_INTERVAL_MINUTES,
    `o intervalo mínimo é de ${MIN_INTERVAL_MINUTES} minutos`,
  )
  .refine(
    (s) => intervalMinutes(s) <= MAX_INTERVAL_MINUTES,
    "o intervalo máximo é de 31 dias (para mais, use uma rotina mensal)",
  );

/** When a routine fires. Structured fields only: there is no cron text anywhere. */
export const scheduleSchema = z.discriminatedUnion("kind", [
  onceScheduleSchema,
  dailyScheduleSchema,
  weeklyScheduleSchema,
  monthlyScheduleSchema,
  intervalScheduleSchema,
]);
export type Schedule = z.infer<typeof scheduleSchema>;
export type IntervalSchedule = z.infer<typeof intervalScheduleSchema>;

export function intervalMinutes(s: { every: number; unit: IntervalUnit }): number {
  return s.unit === "hours" ? s.every * 60 : s.every;
}

// ---------------------------------------------------------------------------------------------
// Time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let made = formatters.get(timeZone);
  if (made === undefined) {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, made);
  }
  return made;
}

export interface WallClock extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock of `instant` in `timeZone`. */
export function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    // some engines write midnight as 24 with h23 on old versions; normalize
    hour: num("hour") % 24,
    minute: num("minute"),
    second: num("second"),
  };
}

/** Minutes the wall clock of `timeZone` is ahead of UTC at `instant` (Sao Paulo now: -180). */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const w = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

const sameWall = (w: WallClock, date: LocalDate, hour: number, minute: number): boolean =>
  w.year === date.year &&
  w.month === date.month &&
  w.day === date.day &&
  w.hour === hour &&
  w.minute === minute;

/**
 * The instant a wall time of `timeZone` happens. A wall time that happens twice gives the FIRST
 * instant; one that does not exist (inside a forward jump of the clock) gives the first valid
 * instant after the gap (the moment of the jump).
 */
export function instantOfWallTime(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const day = 24 * 60 * 60_000;
  const offsets = new Set([
    offsetMinutesAt(new Date(naive - day), timeZone),
    offsetMinutesAt(new Date(naive), timeZone),
    offsetMinutesAt(new Date(naive + day), timeZone),
  ]);
  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset * 60_000;
    if (sameWall(wallClockAt(new Date(candidate), timeZone), date, hour, minute)) {
      valid.push(candidate);
    }
  }
  if (valid.length > 0) return new Date(Math.min(...valid));
  // In a gap: the jump is between `naive - larger offset` (still before it) and `naive - smaller
  // offset` (already after it). Find the first instant on the later side, to the second.
  const sorted = [...offsets].sort((a, b) => a - b);
  const smaller = sorted[0] ?? 0;
  const larger = sorted[sorted.length - 1] ?? 0;
  let lo = naive - larger * 60_000; // before the jump: the old (smaller) offset applies here
  let hi = naive - smaller * 60_000;
  const before = offsetMinutesAt(new Date(lo), timeZone);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetMinutesAt(new Date(mid), timeZone) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

const addDays = (date: LocalDate, days: number): LocalDate => {
  const t = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};
const compareDates = (a: LocalDate, b: LocalDate): number =>
  a.year !== b.year ? a.year - b.year : a.month !== b.month ? a.month - b.month : a.day - b.day;
const weekdayOf = (date: LocalDate): Weekday =>
  WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] as Weekday;

/** Where a schedule is anchored and in which zone it reads its wall times. */
export interface ScheduleContext {
  timeZone: string;
  /** The moment the schedule was set: an interval counts its periods from here. */
  anchor: Date;
}

/** The longest stretch of local days the search for the next fire looks at. */
const SEARCH_DAYS = 800;

function untilOf(schedule: Schedule): LocalDate | null {
  if (schedule.kind === "once" || schedule.until === undefined) return null;
  return parseLocalDate(schedule.until);
}

/**
 * The first instant the schedule fires STRICTLY after `after`, or `null` when it never fires again
 * (a single date already past, or the end date reached).
 */
export function nextFireAfter(schedule: Schedule, ctx: ScheduleContext, after: Date): Date | null {
  const { timeZone } = ctx;
  const end = untilOf(schedule);
  if (schedule.kind === "interval") {
    const period = intervalMinutes(schedule) * 60_000;
    const anchor = ctx.anchor.getTime();
    const k = Math.max(1, Math.floor((after.getTime() - anchor) / period) + 1);
    const at = new Date(anchor + k * period);
    if (end !== null && compareDates(wallClockAt(at, timeZone), end) > 0) return null;
    return at;
  }
  const time = parseLocalTime(schedule.time);
  if (time === null) return null;
  if (schedule.kind === "once") {
    const date = parseLocalDate(schedule.date);
    if (date === null) return null;
    const at = instantOfWallTime(date, time.hour, time.minute, timeZone);
    return at.getTime() > after.getTime() ? at : null;
  }
  // Start a day early: a fire on the previous local date can still be after `after` near a jump.
  let date = addDays(wallClockAt(after, timeZone), -1);
  for (let i = 0; i < SEARCH_DAYS; i++, date = addDays(date, 1)) {
    if (end !== null && compareDates(date, end) > 0) return null;
    let matches: boolean;
    if (schedule.kind === "daily") matches = true;
    else if (schedule.kind === "weekly") matches = schedule.days.includes(weekdayOf(date));
    else matches = date.day === Math.min(schedule.day, daysInMonth(date.year, date.month));
    if (!matches) continue;
    const at = instantOfWallTime(date, time.hour, time.minute, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/** The most fire times `fireTimesBetween` walks one by one (an interval is counted, not walked). */
export const MAX_COUNTED_FIRES = 10_000;

/**
 * The fire times in `(from, to]`: how many there are and the latest one. This is what a scheduler
 * that was off sees when it comes back: one catch-up for `last`, the others counted as missed.
 * `count` stops at `MAX_COUNTED_FIRES` for the kinds that are walked.
 */
export function fireTimesBetween(
  schedule: Schedule,
  ctx: ScheduleContext,
  from: Date,
  to: Date,
): { count: number; last: Date | null } {
  if (to.getTime() <= from.getTime()) return { count: 0, last: null };
  if (schedule.kind === "interval" && untilOf(schedule) === null) {
    const period = intervalMinutes(schedule) * 60_000;
    const anchor = ctx.anchor.getTime();
    const first = Math.max(1, Math.floor((from.getTime() - anchor) / period) + 1);
    const lastK = Math.floor((to.getTime() - anchor) / period);
    if (lastK < first) return { count: 0, last: null };
    return { count: lastK - first + 1, last: new Date(anchor + lastK * period) };
  }
  let count = 0;
  let last: Date | null = null;
  let cursor = from;
  while (count < MAX_COUNTED_FIRES) {
    const next = nextFireAfter(schedule, ctx, cursor);
    if (next === null || next.getTime() > to.getTime()) break;
    count++;
    last = next;
    cursor = next;
  }
  return { count, last };
}

// ---------------------------------------------------------------------------------------------
// In words (pt-BR), for the card, the panel and the bot's own message

const DAY_NAMES: Record<Weekday, { name: string; plural: string; feminine: boolean }> = {
  sun: { name: "domingo", plural: "domingos", feminine: false },
  mon: { name: "segunda", plural: "segundas", feminine: true },
  tue: { name: "terça", plural: "terças", feminine: true },
  wed: { name: "quarta", plural: "quartas", feminine: true },
  thu: { name: "quinta", plural: "quintas", feminine: true },
  fri: { name: "sexta", plural: "sextas", feminine: true },
  sat: { name: "sábado", plural: "sábados", feminine: false },
};
/** Monday first, as people in Brazil list the week. */
const WEEK_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

const brDate = (text: string): string => {
  const d = parseLocalDate(text);
  return d === null ? text : `${pad2(d.day)}/${pad2(d.month)}/${d.year}`;
};

function weekdaysInWords(days: readonly Weekday[]): string {
  const set = new Set(days);
  const ordered = WEEK_ORDER.filter((d) => set.has(d));
  if (ordered.length === 7) return "todo dia";
  const workweek: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
  if (ordered.length === 5 && workweek.every((d) => set.has(d))) return "de segunda a sexta";
  if (ordered.length === 2 && set.has("sat") && set.has("sun")) return "todo sábado e domingo";
  // "toda segunda, quarta e sexta"; the article changes with the gender of the day.
  const words: string[] = [];
  let lastFeminine: boolean | undefined;
  for (const d of ordered) {
    const { name, feminine } = DAY_NAMES[d];
    words.push(lastFeminine === feminine ? name : `${feminine ? "toda" : "todo"} ${name}`);
    lastFeminine = feminine;
  }
  return joinWords(words);
}

/**
 * The schedule in Portuguese, as the user reads it: "todo dia às 08:00", "toda segunda e quarta às
 * 09:30", "todo dia 31 às 08:00 (no último dia, nos meses mais curtos)", "a cada 30 minutos",
 * "uma vez, em 01/12/2026 às 08:00", with " até 31/12/2026" when it has an end date.
 */
export function describeSchedule(schedule: Schedule): string {
  const end =
    schedule.kind !== "once" && schedule.until !== undefined
      ? `, até ${brDate(schedule.until)}`
      : "";
  switch (schedule.kind) {
    case "once":
      return `uma vez, em ${brDate(schedule.date)} às ${schedule.time}`;
    case "daily":
      return `todo dia às ${schedule.time}${end}`;
    case "weekly":
      return `${weekdaysInWords(schedule.days)} às ${schedule.time}${end}`;
    case "monthly":
      return `todo dia ${schedule.day} às ${schedule.time}${
        schedule.day > 28 ? " (no último dia, nos meses mais curtos)" : ""
      }${end}`;
    case "interval": {
      if (schedule.unit === "hours") {
        return `${schedule.every === 1 ? "a cada hora" : `a cada ${schedule.every} horas`}${end}`;
      }
      return `${schedule.every === 1 ? "a cada minuto" : `a cada ${schedule.every} minutos`}${end}`;
    }
  }
}

/** A day of the week in words, for a form (Monday first). */
export const WEEKDAY_LABELS: readonly { day: Weekday; label: string; short: string }[] =
  WEEK_ORDER.map((day) => ({
    day,
    label: DAY_NAMES[day].name,
    short: DAY_NAMES[day].name.slice(0, 3),
  }));
