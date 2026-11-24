import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  fireTimesBetween,
  instantOfWallTime,
  isKnownTimeZone,
  nextFireAfter,
  offsetMinutesAt,
  parseLocalDate,
  parseLocalTime,
  routineNameKey,
  type Schedule,
  sameSchedule,
  scheduleSchema,
} from "./schedule.js";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const LIS = "Europe/Lisbon";
const at = (iso: string) => new Date(iso);
const ctx = (timeZone: string, anchor = "2026-01-01T00:00:00Z") => ({
  timeZone,
  anchor: at(anchor),
});
const next = (s: Schedule, timeZone: string, after: string, anchor?: string) =>
  nextFireAfter(s, ctx(timeZone, anchor), at(after))?.toISOString() ?? null;

describe("reading dates and times without a pattern", () => {
  it("reads HH:MM and refuses anything else", () => {
    expect(parseLocalTime("08:00")).toEqual({ hour: 8, minute: 0 });
    expect(parseLocalTime("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["8:00", "24:00", "12:60", "12-00", "ab:cd", "12:00 ", "", "1200"]) {
      expect(parseLocalTime(bad)).toBeNull();
    }
  });

  it("reads YYYY-MM-DD, knows the leap years and refuses impossible dates", () => {
    expect(parseLocalDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseLocalDate("2000-02-29")).not.toBeNull();
    expect(parseLocalDate("2027-02-29")).toBeNull();
    expect(parseLocalDate("2100-02-29")).toBeNull();
    expect(parseLocalDate("2026-04-31")).toBeNull();
    for (const bad of ["2026-1-01", "2026/01/01", "26-01-01", "2026-13-01", "2026-00-10"]) {
      expect(parseLocalDate(bad)).toBeNull();
    }
  });

  it("knows the time zones Intl knows", () => {
    expect(isKnownTimeZone(SP)).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });
});

describe("the schema of a schedule (structured fields, no cron)", () => {
  it("accepts the five kinds", () => {
    for (const s of [
      { kind: "once", date: "2026-12-01", time: "08:00" },
      { kind: "daily", time: "08:00" },
      { kind: "weekly", days: ["mon", "wed"], time: "09:30", until: "2026-12-31" },
      { kind: "monthly", day: 31, time: "07:00" },
      { kind: "interval", every: 5, unit: "minutes" },
      { kind: "interval", every: 2, unit: "hours" },
    ]) {
      expect(scheduleSchema.safeParse(s).success).toBe(true);
    }
  });

  it("refuses an interval under 5 minutes or over 31 days, a repeated day and a bad time", () => {
    for (const s of [
      { kind: "interval", every: 4, unit: "minutes" },
      { kind: "interval", every: 745, unit: "hours" },
      { kind: "weekly", days: ["mon", "mon"], time: "09:00" },
      { kind: "weekly", days: [], time: "09:00" },
      { kind: "daily", time: "25:00" },
      { kind: "monthly", day: 32, time: "07:00" },
      { kind: "cron", expression: "0 8 * * *" },
    ]) {
      expect(scheduleSchema.safeParse(s).success).toBe(false);
    }
  });
});

describe("offsets from Intl", () => {
  it("Sao Paulo is UTC-3 today, and was UTC-2 in its old summer time", () => {
    expect(offsetMinutesAt(at("2026-11-22T12:00:00Z"), SP)).toBe(-180);
    expect(offsetMinutesAt(at("2018-12-15T12:00:00Z"), SP)).toBe(-120);
  });

  it("New York and Lisbon change twice a year", () => {
    expect(offsetMinutesAt(at("2026-01-15T12:00:00Z"), NY)).toBe(-300);
    expect(offsetMinutesAt(at("2026-07-15T12:00:00Z"), NY)).toBe(-240);
    expect(offsetMinutesAt(at("2026-01-15T12:00:00Z"), LIS)).toBe(0);
    expect(offsetMinutesAt(at("2026-07-15T12:00:00Z"), LIS)).toBe(60);
  });
});

describe("daily", () => {
  const daily = (time: string): Schedule => ({ kind: "daily", time });

  it("is in the user's zone, whatever the server's: 08:00 in Sao Paulo is 11:00 UTC", () => {
    expect(next(daily("08:00"), SP, "2026-11-22T12:00:00Z")).toBe("2026-11-23T11:00:00.000Z");
    expect(next(daily("08:00"), SP, "2026-11-22T10:59:00Z")).toBe("2026-11-22T11:00:00.000Z");
    // strictly after: firing at 11:00 the next one is tomorrow
    expect(next(daily("08:00"), SP, "2026-11-22T11:00:00Z")).toBe("2026-11-23T11:00:00.000Z");
  });

  it("New York spring forward: 02:30 does not exist and fires at 03:00, once", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT (07:00 UTC)
    const first = next(daily("02:30"), NY, "2026-03-08T00:00:00Z");
    expect(first).toBe("2026-03-08T07:00:00.000Z");
    expect(next(daily("02:30"), NY, first as string)).toBe("2026-03-09T06:30:00.000Z");
  });

  it("New York fall back: 01:30 happens twice and fires once, at the first", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST: 01:30 is 05:30 UTC and again 06:30 UTC
    const first = next(daily("01:30"), NY, "2026-11-01T00:00:00Z");
    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(next(daily("01:30"), NY, first as string)).toBe("2026-11-02T06:30:00.000Z");
  });

  it("Lisbon spring forward and fall back", () => {
    // 2026-03-29 01:00 WET -> 02:00 WEST (01:00 UTC)
    expect(next(daily("01:30"), LIS, "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
    // 2026-10-25 02:00 WEST -> 01:00 WET: 01:30 is 00:30 UTC and 01:30 UTC
    const first = next(daily("01:30"), LIS, "2026-10-24T12:00:00Z");
    expect(first).toBe("2026-10-25T00:30:00.000Z");
    expect(next(daily("01:30"), LIS, first as string)).toBe("2026-10-26T01:30:00.000Z");
  });

  it("Sao Paulo's old summer time: the midnight that did not exist, and the hour that repeated", () => {
    // 2018-11-04 00:00 -> 01:00 (-03 to -02): 00:30 fires at 01:00 local, 03:00 UTC
    expect(next(daily("00:30"), SP, "2018-11-03T12:00:00Z")).toBe("2018-11-04T03:00:00.000Z");
    // 2019-02-17 00:00 -> 2019-02-16 23:00 (-02 to -03): 23:30 of the 16th happens twice
    const first = next(daily("23:30"), SP, "2019-02-16T12:00:00Z");
    expect(first).toBe("2019-02-17T01:30:00.000Z");
    expect(next(daily("23:30"), SP, first as string)).toBe("2019-02-18T02:30:00.000Z");
  });

  it("the gap and the repeated hour resolve the same in instantOfWallTime", () => {
    expect(instantOfWallTime({ year: 2026, month: 3, day: 8 }, 2, 0, NY).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(instantOfWallTime({ year: 2026, month: 3, day: 8 }, 3, 0, NY).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(instantOfWallTime({ year: 2026, month: 11, day: 1 }, 1, 0, NY).toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("stops after its end date (inclusive)", () => {
    const s: Schedule = { kind: "daily", time: "08:00", until: "2026-11-23" };
    expect(next(s, SP, "2026-11-22T12:00:00Z")).toBe("2026-11-23T11:00:00.000Z");
    expect(next(s, SP, "2026-11-23T11:00:00Z")).toBeNull();
  });
});

describe("weekly", () => {
  it("fires on the days asked, in order", () => {
    const s: Schedule = { kind: "weekly", days: ["mon", "wed"], time: "09:30" };
    // 2026-11-22 is a Sunday
    expect(next(s, SP, "2026-11-22T12:00:00Z")).toBe("2026-11-23T12:30:00.000Z");
    expect(next(s, SP, "2026-11-23T12:30:00Z")).toBe("2026-11-25T12:30:00.000Z");
    expect(next(s, SP, "2026-11-25T12:30:00Z")).toBe("2026-11-30T12:30:00.000Z");
  });
});

describe("monthly", () => {
  const monthly = (day: number): Schedule => ({ kind: "monthly", day, time: "08:00" });

  it("a missing day runs on the last day of the month", () => {
    expect(next(monthly(31), SP, "2027-01-31T12:00:00Z")).toBe("2027-02-28T11:00:00.000Z");
    expect(next(monthly(31), SP, "2028-01-31T12:00:00Z")).toBe("2028-02-29T11:00:00.000Z");
    expect(next(monthly(31), SP, "2027-04-01T00:00:00Z")).toBe("2027-04-30T11:00:00.000Z");
    expect(next(monthly(31), SP, "2027-04-30T11:00:00Z")).toBe("2027-05-31T11:00:00.000Z");
  });

  it("the 29th in a year that is not leap is February 28; in a leap year, the 29th", () => {
    expect(next(monthly(29), SP, "2027-02-01T00:00:00Z")).toBe("2027-02-28T11:00:00.000Z");
    expect(next(monthly(29), SP, "2028-02-01T00:00:00Z")).toBe("2028-02-29T11:00:00.000Z");
  });

  it("the day of the month crosses the year", () => {
    expect(next(monthly(5), SP, "2026-12-06T00:00:00Z")).toBe("2027-01-05T11:00:00.000Z");
  });
});

describe("once", () => {
  const once: Schedule = { kind: "once", date: "2026-12-01", time: "08:00" };
  it("fires once, then never", () => {
    expect(next(once, SP, "2026-11-22T12:00:00Z")).toBe("2026-12-01T11:00:00.000Z");
    expect(next(once, SP, "2026-12-01T11:00:00Z")).toBeNull();
  });
});

describe("interval", () => {
  it("counts absolute durations from its anchor, through a change of the clock", () => {
    const s: Schedule = { kind: "interval", every: 30, unit: "minutes" };
    const anchor = "2026-03-08T06:00:00Z"; // 01:00 EST, the night New York jumps
    expect(next(s, NY, anchor, anchor)).toBe("2026-03-08T06:30:00.000Z");
    expect(next(s, NY, "2026-03-08T06:59:59Z", anchor)).toBe("2026-03-08T07:00:00.000Z");
    expect(next(s, NY, "2026-03-08T07:00:00Z", anchor)).toBe("2026-03-08T07:30:00.000Z");
    const between = fireTimesBetween(s, ctx(NY, anchor), at(anchor), at("2026-03-08T08:00:00Z"));
    expect(between).toEqual({ count: 4, last: at("2026-03-08T08:00:00Z") });
  });

  it("the first fire is one period after the anchor, never at once", () => {
    const s: Schedule = { kind: "interval", every: 2, unit: "hours" };
    expect(next(s, SP, "2026-11-22T10:00:00Z", "2026-11-22T10:00:00Z")).toBe(
      "2026-11-22T12:00:00.000Z",
    );
    expect(next(s, SP, "2026-11-22T09:00:00Z", "2026-11-22T10:00:00Z")).toBe(
      "2026-11-22T12:00:00.000Z",
    );
  });

  it("stops at its end date in the user's zone", () => {
    const s: Schedule = { kind: "interval", every: 6, unit: "hours", until: "2026-11-22" };
    // 2026-11-22T21:00 local (00:00 UTC of the 23rd) is still the 22nd in Sao Paulo
    expect(next(s, SP, "2026-11-22T20:00:00Z", "2026-11-22T00:00:00Z")).toBe(
      "2026-11-23T00:00:00.000Z",
    );
    expect(next(s, SP, "2026-11-23T00:00:00Z", "2026-11-22T00:00:00Z")).toBeNull();
  });
});

describe("what a scheduler that was off finds (one catch-up, the rest counted)", () => {
  it("three missed days of a daily routine: three fire times, the latest is the catch-up", () => {
    const s: Schedule = { kind: "daily", time: "08:00" };
    const found = fireTimesBetween(s, ctx(SP), at("2026-11-20T11:00:00Z"), at("2026-11-23T12:00Z"));
    expect(found).toEqual({ count: 3, last: at("2026-11-23T11:00:00Z") });
  });

  it("a month of a 5-minute interval is counted without walking it", () => {
    const s: Schedule = { kind: "interval", every: 5, unit: "minutes" };
    const found = fireTimesBetween(
      s,
      ctx(SP, "2026-10-01T00:00:00Z"),
      at("2026-10-01T00:00:00Z"),
      at("2026-10-31T00:00:00Z"),
    );
    expect(found.count).toBe(30 * 24 * 12);
    expect(found.last?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("nothing in an empty window", () => {
    const s: Schedule = { kind: "daily", time: "08:00" };
    expect(fireTimesBetween(s, ctx(SP), at("2026-11-23T12:00Z"), at("2026-11-23T12:00Z"))).toEqual({
      count: 0,
      last: null,
    });
  });
});

describe("in words", () => {
  it("says each kind as a person would", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("todo dia às 08:00");
    expect(describeSchedule({ kind: "weekly", days: ["wed", "mon"], time: "09:30" })).toBe(
      "toda segunda e quarta às 09:30",
    );
    expect(
      describeSchedule({
        kind: "weekly",
        days: ["mon", "tue", "wed", "thu", "fri"],
        time: "07:00",
      }),
    ).toBe("de segunda a sexta às 07:00");
    expect(describeSchedule({ kind: "weekly", days: ["sat", "sun"], time: "10:00" })).toBe(
      "todo sábado e domingo às 10:00",
    );
    expect(describeSchedule({ kind: "weekly", days: ["fri", "sat"], time: "18:00" })).toBe(
      "toda sexta e todo sábado às 18:00",
    );
    expect(describeSchedule({ kind: "monthly", day: 5, time: "08:00" })).toBe(
      "todo dia 5 às 08:00",
    );
    expect(describeSchedule({ kind: "monthly", day: 31, time: "08:00" })).toBe(
      "todo dia 31 às 08:00 (no último dia, nos meses mais curtos)",
    );
    expect(describeSchedule({ kind: "interval", every: 30, unit: "minutes" })).toBe(
      "a cada 30 minutos",
    );
    expect(describeSchedule({ kind: "interval", every: 1, unit: "hours" })).toBe("a cada hora");
    expect(describeSchedule({ kind: "once", date: "2026-12-01", time: "08:00" })).toBe(
      "uma vez, em 01/12/2026 às 08:00",
    );
    expect(describeSchedule({ kind: "daily", time: "08:00", until: "2026-12-31" })).toBe(
      "todo dia às 08:00, até 31/12/2026",
    );
  });
});

describe("the same schedule, the same name (for a duplicate routine; no text compared)", () => {
  it("compares the fields exactly: weekly days as a set, an interval by its minutes", () => {
    const daily: Schedule = { kind: "daily", time: "20:00", until: "2026-11-30" };
    expect(sameSchedule(daily, { kind: "daily", time: "20:00", until: "2026-11-30" })).toBe(true);
    expect(sameSchedule(daily, { kind: "daily", time: "20:00" })).toBe(false);
    expect(sameSchedule(daily, { kind: "daily", time: "20:01", until: "2026-11-30" })).toBe(false);
    expect(
      sameSchedule(
        { kind: "weekly", days: ["mon", "wed"], time: "09:00" },
        { kind: "weekly", days: ["wed", "mon"], time: "09:00" },
      ),
    ).toBe(true);
    expect(
      sameSchedule(
        { kind: "weekly", days: ["mon", "wed"], time: "09:00" },
        { kind: "weekly", days: ["mon"], time: "09:00" },
      ),
    ).toBe(false);
    expect(
      sameSchedule(
        { kind: "interval", every: 2, unit: "hours" },
        { kind: "interval", every: 120, unit: "minutes" },
      ),
    ).toBe(true);
    expect(
      sameSchedule({ kind: "monthly", day: 5, time: "08:00" }, { kind: "daily", time: "08:00" }),
    ).toBe(false);
    expect(
      sameSchedule(
        { kind: "once", date: "2026-12-01", time: "08:00" },
        { kind: "once", date: "2026-12-01", time: "08:00" },
      ),
    ).toBe(true);
  });

  it("folds case and trims the ends of a name; nothing else is equal", () => {
    expect(routineNameKey("  Lembrete: Provas ")).toBe(routineNameKey("lembrete: provas"));
    expect(routineNameKey("ÁGUA")).toBe(routineNameKey("água"));
    // the same letter composed or decomposed is the same name
    expect(routineNameKey("Água")).toBe(routineNameKey("A\u0301gua"));
    expect(routineNameKey("Lembrete provas")).not.toBe(routineNameKey("Lembrete: provas"));
  });
});
