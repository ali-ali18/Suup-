import type { Db } from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  CREATE_REMINDER_TOOL,
  createReminderCardLine,
  createReminderTool,
  createRoutineCardLine,
  createRoutineTool,
  deleteRoutineTool,
  listRoutinesTool,
  ROUTINE_TOOL_NAMES,
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

  it("one time is a reminder, not a routine: create_routine refuses `once` and points to the reminder", async () => {
    const tool = createRoutineTool(db, async () => "America/Sao_Paulo");
    expect(tool.description).toContain("create_reminder");
    expect(tool.description).toContain("schedule_return");
    const out = await tool.execute(
      {
        name: "Lembrete",
        instruction: "Lembrar do RG.",
        schedule: { kind: "once", date: "2026-11-29", time: "19:00" },
      },
      { botId: "b", runId: "r" } as never,
    );
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("create_reminder");
    expect(String(out.content)).toContain("schedule_return");
  });

  it("create_reminder: offered with the routine tools, a standing permission, its card in Portuguese", () => {
    expect(ROUTINE_TOOL_NAMES).toContain(CREATE_REMINDER_TOOL);
    const tool = createReminderTool(db, async () => "America/Sao_Paulo");
    expect(tool.name).toBe("create_reminder");
    expect(tool.risk).toBe("write_reversible");
    expect(tool.description).toContain("schedule_return");
    expect(tool.description).toContain("not in their panel");
    expect(createReminderCardLine("enviar o RG", "2026-11-29", "19:00")).toBe(
      "Criar um lembrete: enviar o RG — uma vez, em 29/11/2026 às 19:00",
    );
    expect(
      tool.describe?.({ text: "pagar o boleto", date: "2026-11-29", time: "19:00" }, env),
    ).toBe("Criar um lembrete: pagar o boleto — uma vez, em 29/11/2026 às 19:00");
  });
});
