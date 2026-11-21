// The user's clock, in plain numbers, for the jobs that run "at night" and "in the morning" in
// their time zone. Pure; no pattern matching: the clock comes from `Intl` parts and the "HH:MM"
// of the settings is read by splitting on the colon.

/** The local date (`YYYY-MM-DD`) and the minute of the day (0 to 1439) of `date` in `timeZone`. */
export interface LocalClock {
  date: string;
  minute: number;
}

/** An unknown time zone falls back to UTC (the same rule the prompt uses for the clock). */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function localClock(date: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: knownZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/** `"03:00"` to 180; `null` for anything that is not `HH:MM` with a valid hour and minute. */
export function parseClockTime(text: string): number | null {
  const pieces = text.split(":");
  if (pieces.length !== 2) return null;
  const [h, m] = pieces as [string, string];
  if (h.length !== 2 || m.length !== 2) return null;
  const digits = "0123456789";
  if (![...h, ...m].every((ch) => digits.includes(ch))) return null;
  const hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 180 to `"03:00"`. */
export function formatClockTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
