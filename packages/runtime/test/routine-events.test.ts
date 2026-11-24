import { createBot, createRoutine, deleteRoutine } from "@suup/db";
import { describe, expect, it } from "vitest";
import { ownRoutinesFor } from "../src/routines.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("the bot is told what happened to its routines"), () => {
  const ctx = useIsolatedDb();

  it("a routine the owner deleted is listed as deleted by the owner, not as missing (M14)", async () => {
    const bot = await createBot(ctx.db, { name: "Agenda", modelProvider: "p", modelId: "m" });
    const routine = await createRoutine(ctx.db, {
      botId: bot.id,
      name: "Bom dia",
      instruction: "Dê bom dia.",
      schedule: { kind: "daily", time: "08:00" },
      timeZone: "America/Sao_Paulo",
      createdBy: "bot",
    });
    await deleteRoutine(ctx.db, routine.id, "owner");
    const own = await ownRoutinesFor(ctx.db, bot.id);
    expect(own.items).toEqual([]);
    expect(own.recent).toMatchObject([{ kind: "deleted", actor: "owner", name: "Bom dia" }]);
    // a change older than the window is not carried
    const later = new Date(Date.now() + 30 * 86_400_000);
    expect((await ownRoutinesFor(ctx.db, bot.id, 20, later)).recent).toBeUndefined();
  });

  it("a reminder that already went off is listed as fired, and is not pending (M15)", async () => {
    const bot = await createBot(ctx.db, { name: "Lembra", modelProvider: "p", modelId: "m" });
    const reminder = await createRoutine(ctx.db, {
      botId: bot.id,
      name: "Pagar o boleto",
      instruction: "Lembrar de pagar o boleto.",
      schedule: { kind: "once", date: "2999-01-01", time: "10:00" },
      timeZone: "UTC",
      createdBy: "bot",
      reminder: true,
    });
    expect((await ownRoutinesFor(ctx.db, bot.id)).items.map((i) => i.name)).toEqual([
      "Pagar o boleto",
    ]);
    await deleteRoutine(ctx.db, reminder.id, "system", "fired");
    const own = await ownRoutinesFor(ctx.db, bot.id);
    expect(own.items).toEqual([]);
    expect(own.recent).toMatchObject([{ kind: "fired", reminder: true, name: "Pagar o boleto" }]);
  });
});
