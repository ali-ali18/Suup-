import type { RoutineFire } from "@suup/api";
import { describe, expect, it } from "vitest";
import { routineOf } from "../test-fixtures.js";
import {
  describeSchedule,
  editDraft,
  fireKindText,
  fireStatusText,
  lastText,
  nextText,
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

describe("Editar: the draft for the chat (no schedule form in the app)", () => {
  it("names the routine and when it runs, in words, and ends ready for the change", () => {
    expect(editDraft(routineOf())).toBe(
      "Editar a rotina “Calendário da manhã” (todo dia às 08:00): ",
    );
    expect(
      editDraft(
        routineOf({
          name: "Resumo",
          schedule: { kind: "weekly", days: ["mon", "fri"], time: "18:00" },
        }),
      ),
    ).toBe("Editar a rotina “Resumo” (toda segunda e sexta às 18:00): ");
    // never the id
    expect(editDraft(routineOf())).not.toContain(routineOf().id);
  });

  it("a routine whose saved schedule the server could not read says so in plain words", () => {
    const broken = routineOf({ schedule: null, problem: "O horário salvo não é válido." });
    expect(describeSchedule(broken.schedule)).toBe("Horário inválido: peça ao bot um novo horário");
    expect(editDraft(broken)).toBe(
      "Editar a rotina “Calendário da manhã” (Horário inválido: peça ao bot um novo horário): ",
    );
  });
});
