import type { Db } from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRoutineCardLine,
  createRoutineTool,
  deleteRoutineTool,
  duplicateRoutineOf,
  listRoutinesTool,
  updateRoutineStateTool,
  updateRoutineTool,
} from "../src/index.js";

// The tools never reach the database here: only what they declare (level, card line) is checked.
const db = {} as Db;
const env = { executor: { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } } as never;

describe("routine tools: what they declare", () => {
  it("the card of create_routine says what and when, in Portuguese", () => {
    expect(
      createRoutineCardLine("Veja meu calendário e me diga o que tenho.", {
        kind: "weekly",
        days: ["mon", "wed"],
        time: "08:00",
      }),
    ).toBe(
      "Criar uma rotina: Veja meu calendário e me diga o que tenho. — toda segunda e quarta às 08:00",
    );
    const tool = createRoutineTool(db, async () => "America/Sao_Paulo");
    expect(tool.risk).toBe("write_reversible");
    expect(
      tool.describe?.(
        {
          name: "n",
          instruction: "Resuma meus e-mails.",
          schedule: { kind: "daily", time: "07:30" },
        },
        env,
      ),
    ).toBe("Criar uma rotina: Resuma meus e-mails. — todo dia às 07:30");
  });

  it("changing or resuming is a standing permission; pausing and deleting are free", () => {
    const update = updateRoutineTool(db);
    expect(update.classify?.({ routine: "a", paused: true }, env)).toBe("read");
    expect(update.classify?.({ routine: "a", paused: false }, env)).toBe("write_reversible");
    expect(
      update.classify?.(
        { routine: "a", paused: true, schedule: { kind: "daily", time: "09:00" } },
        env,
      ),
    ).toBe("write_reversible");
    expect(update.describe?.({ routine: "Manhã", paused: true }, env)).toBe(
      'Pausar a rotina "Manhã"',
    );
    expect(
      update.describe?.({ routine: "Manhã", schedule: { kind: "daily", time: "09:00" } }, env),
    ).toBe('Mudar a rotina "Manhã": todo dia às 09:00');
    // the routine the user's message is about ("Editar"): the card names it, never by its id
    const named = {
      executor: { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      routineNames: new Map([["rot-1", "Calendário da manhã"]]),
    } as never;
    expect(
      update.describe?.({ routine: "rot-1", schedule: { kind: "daily", time: "07:00" } }, named),
    ).toBe('Mudar a rotina "Calendário da manhã": todo dia às 07:00');
    expect(update.describe?.({ routine: "rot-1", paused: true }, named)).toBe(
      'Pausar a rotina "Calendário da manhã"',
    );
    expect(deleteRoutineTool(db).describe?.({ routine: "rot-1" }, named)).toBe(
      'Apagar a rotina "Calendário da manhã"',
    );
    expect(deleteRoutineTool(db).risk).toBe("read");
    expect(listRoutinesTool(db).risk).toBe("read");
    expect(updateRoutineStateTool(db).risk).toBe("read");
  });
});

describe("create_routine: the same routine twice", () => {
  const daily = { kind: "daily" as const, time: "20:00", until: "2026-11-30" };
  const mine = [
    {
      id: "r1",
      name: "Lembrete: trabalhos e prova",
      schedule: daily,
      timeZone: "America/Sao_Paulo",
      status: "active" as const,
    },
    {
      id: "r2",
      name: "Antiga",
      schedule: daily,
      timeZone: "America/Sao_Paulo",
      status: "ended" as const,
    },
  ];
  const zone = "America/Sao_Paulo";

  it("finds one that is not ended, with the same name (case and ends ignored) and schedule", () => {
    expect(
      duplicateRoutineOf(mine, {
        name: " lembrete: TRABALHOS e prova ",
        schedule: daily,
        timeZone: zone,
      })?.id,
    ).toBe("r1");
  });

  it("another name, another schedule, another zone or an ended routine is not a duplicate", () => {
    expect(
      duplicateRoutineOf(mine, { name: "Lembrete provas", schedule: daily, timeZone: zone }),
    ).toBeUndefined();
    expect(
      duplicateRoutineOf(mine, {
        name: "Lembrete: trabalhos e prova",
        schedule: { kind: "daily", time: "21:00", until: "2026-11-30" },
        timeZone: zone,
      }),
    ).toBeUndefined();
    expect(
      duplicateRoutineOf(mine, {
        name: "Lembrete: trabalhos e prova",
        schedule: daily,
        timeZone: "UTC",
      }),
    ).toBeUndefined();
    expect(
      duplicateRoutineOf(mine, { name: "Antiga", schedule: daily, timeZone: zone }),
    ).toBeUndefined();
  });
});
