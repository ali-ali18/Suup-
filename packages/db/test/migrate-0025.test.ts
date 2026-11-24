import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBot, getBot, MIGRATIONS_DIR, migrate, updateBot } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0025: the avatar style. Bots from before stay on the shapes (nothing changes for them);
// the column accepts only the two known styles, whatever the code says.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0025: bot avatar style"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("keeps every bot of before on the shapes and accepts only shapes or pixel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0025" && f.endsWith(".sql"));
    expect(held).toEqual([
      "0025_bot_avatar_style.sql",
      "0026_routines.sql",
      "0027_message_routine_ref.sql",
      "0028_connector_oauth_catalog.sql",
      "0029_routine_reminders.sql",
      "0030_files.sql",
      "0031_web_search_usage.sql",
      "0032_secrets_managed_by.sql",
      "0033_routine_events.sql",
    ]);
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);
    const [old] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id, avatar, color)
      values ('antigo', 'p', 'm', 'mascot:gota', 'azul') returning id`;

    expect(await migrate(ctx.db)).toEqual(held);

    expect(await getBot(ctx.db, old?.id as string)).toMatchObject({
      avatar: "mascot:gota",
      color: "azul",
      avatarStyle: "shapes",
      avatarPixel3d: false,
    });
    const pixel = await createBot(ctx.db, {
      name: "pixel",
      modelProvider: "p",
      modelId: "m",
      avatar: "mascot:gato",
      avatarStyle: "pixel",
    });
    expect(pixel.avatarStyle).toBe("pixel");
    expect(pixel.avatarPixel3d).toBe(false);
    const cube = await createBot(ctx.db, {
      name: "cubo",
      modelProvider: "p",
      modelId: "m",
      avatar: "mascot:robo",
      avatarStyle: "pixel",
      avatarPixel3d: true,
    });
    expect(cube.avatarPixel3d).toBe(true);
    expect((await updateBot(ctx.db, cube.id, { avatarPixel3d: false }))?.avatarPixel3d).toBe(false);
    expect((await updateBot(ctx.db, cube.id, { name: "cubo2" }))?.avatarPixel3d).toBe(false);
    expect((await updateBot(ctx.db, pixel.id, { avatarStyle: "shapes" }))?.avatarStyle).toBe(
      "shapes",
    );
    await expect(
      ctx.db.sql`update bots set avatar_style = 'neon' where id = ${pixel.id}`,
    ).rejects.toThrow();
    expect(await migrate(ctx.db)).toEqual([]);
  });
});

// A database that had the routines (0026, 0027) before the avatar style: 0025 applies by itself.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0025 after 0026 and 0027"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("applies alone on a database that already has the later ones (the routines came first)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await rm(join(dir, "0025_bot_avatar_style.sql"));
    await migrate(ctx.db, dir);
    const [old] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id, avatar, color)
      values ('antigo', 'p', 'm', 'mascot:gota', 'azul') returning id`;

    expect(await migrate(ctx.db)).toEqual(["0025_bot_avatar_style.sql"]);

    expect(await getBot(ctx.db, old?.id as string)).toMatchObject({
      avatarStyle: "shapes",
      avatarPixel3d: false,
    });
    expect(await migrate(ctx.db)).toEqual([]);
  });
});
