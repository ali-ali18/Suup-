import type { RoutineFire, Schedule } from "@suup/api";
import { describe, expect, it } from "vitest";
import { routineOf } from "../test-fixtures.js";
import {
  draftOf,
  fireKindText,
  fireStatusText,
  lastText,
  nextText,
  toSchedule,
  whenText,
} from "./routines.js";

const SP = "America/Sao_Paulo";
const NOW = new Date("2026-11-22T12:00:00.000Z"); // Sunday 09:00 in Sao Paulo

const fireOf = (over: Partial<RoutineFire> = {}): RoutineFire => ({
  id: "00000000-0000-4000-8000-000000000001",
  routineId: "00000000-0000-4000-8000-000000000002",
  scheduledFor: "2026-11-22T11:00:00.000Z",
  kind: "scheduled",
  status: "done",
  skipReason: null,
  missedCount: 0,
  runId: "00000000-0000-4000-8000-000000000003",
  resultText: "Hoje: dentista às 15h.",
  messageId: null,
  createdAt: "2026-11-22T11:00:01.000Z",
  finishedAt: "2026-11-22T11:00:09.000Z",
  ...over,
});

describe("the routine in words", () => {
  it("says when in the routine's zone: today, tomorrow, or the date", () => {
    expect(whenText("2026-11-22T11:00:00.000Z", SP, NOW)).toBe("hoje, 08:00");
    expect(whenText("2026-11-23T11:00:00.000Z", SP, NOW)).toBe("amanhã, 08:00");
    expect(whenText("2026-11-21T11:00:00.000Z", SP, NOW)).toBe("ontem, 08:00");
    const wednesday = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: SP }).format(
      new Date("2026-11-25T12:30:00.000Z"),
    );
    expect(whenText("2026-11-25T12:30:00.000Z", SP, NOW)).toBe(`${wednesday}, 25/11, 09:30`);
    // 01:00 UTC of the 23rd is still the 22nd, 22:00, in Sao Paulo
    expect(whenText("2026-11-23T01:00:00.000Z", SP, NOW)).toBe("hoje, 22:00");
  });

  it("the next run, paused and ended; the last result with its kind", () => {
    expect(nextText(routineOf(), NOW)).toBe("Próxima: amanhã, 08:00");
    expect(nextText(routineOf({ status: "paused", nextRunAt: null }), NOW)).toBe("Pausada");
    expect(nextText(routineOf({ status: "ended", nextRunAt: null }), NOW)).toBe("Encerrada");
    expect(lastText(routineOf(), NOW)).toBeNull();
    expect(lastText(routineOf({ lastFire: fireOf() }), NOW)).toBe(
      "Última: hoje, 08:00 · Concluída",
    );
    expect(
      lastText(routineOf({ lastFire: fireOf({ kind: "catch_up", missedCount: 3 }) }), NOW),
    ).toBe("Última: hoje, 08:00 · Concluída · Recuperação · 3 perdidas");
  });

  it("each fire of the history", () => {
    expect(fireStatusText(fireOf({ status: "skipped", skipReason: "overlap" }))).toBe(
      "Pulada: a anterior ainda rodava",
    );
    expect(fireStatusText(fireOf({ status: "failed" }))).toBe("Falhou");
    expect(fireKindText(fireOf())).toBeNull();
    expect(fireKindText(fireOf({ kind: "manual" }))).toBe("Rodar agora");
    expect(fireKindText(fireOf({ kind: "catch_up", missedCount: 1 }))).toBe(
      "Recuperação · 1 perdida",
    );
    expect(fireKindText(fireOf({ kind: "catch_up" }))).toBe("Recuperação (atrasada)");
  });
});

describe("the form of a schedule (structured fields, no cron)", () => {
  it("goes from a schedule to the form and back", () => {
    const schedules: Schedule[] = [
      { kind: "daily", time: "08:00" },
      { kind: "weekly", days: ["mon", "wed"], time: "09:30", until: "2026-12-31" },
      { kind: "monthly", day: 31, time: "07:00" },
      { kind: "interval", every: 2, unit: "hours" },
      { kind: "once", date: "2026-12-01", time: "08:00" },
    ];
    for (const schedule of schedules) {
      expect(toSchedule(draftOf(schedule))).toEqual({ schedule });
    }
  });

  it("says what is missing, in words", () => {
    const weekly = draftOf({ kind: "weekly", days: ["mon"], time: "09:30" });
    expect(toSchedule({ ...weekly, days: [] })).toEqual({ error: "Escolha pelo menos um dia." });
    const once = draftOf({ kind: "once", date: "2026-12-01", time: "08:00" });
    expect(toSchedule({ ...once, date: "01/12/2026" })).toEqual({ error: "Escolha a data." });
    const every = draftOf({ kind: "interval", every: 30, unit: "minutes" });
    expect(toSchedule({ ...every, every: 2 })).toEqual({
      error: "o intervalo mínimo é de 5 minutos",
    });
    expect(toSchedule({ ...draftOf({ kind: "daily", time: "08:00" }), until: "amanhã" })).toEqual({
      error: "A data de fim não é válida.",
    });
  });
});
