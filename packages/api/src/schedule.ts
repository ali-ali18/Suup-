// The schedule of a routine lives in `@suup/core` (the server computes the next run with it); the
// API exposes it to the app, the CLI and the server. Like `answers.ts`, it re-exports the subpath
// `@suup/core/schedule` (zod and `Intl` only, no Node module), never the index of the core: the
// desktop app imports this file directly.
export {
  daysInMonth,
  describeSchedule,
  fireTimesBetween,
  INTERVAL_UNITS,
  type IntervalUnit,
  instantOfWallTime,
  intervalMinutes,
  isKnownTimeZone,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  nextFireAfter,
  parseLocalDate,
  parseLocalTime,
  SCHEDULE_KINDS,
  type Schedule,
  type ScheduleKind,
  scheduleSchema,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type Weekday,
  wallClockAt,
} from "@suup/core/schedule";
