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
    expect(held).toEqual(["0025_bot_avatar_style.sql"]);
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
    });
    const pixel = await createBot(ctx.db, {
      name: "pixel",
      modelProvider: "p",
      modelId: "m",
      avatar: "mascot:gato",
      avatarStyle: "pixel",
    });
    expect(pixel.avatarStyle).toBe("pixel");
    expect((await updateBot(ctx.db, pixel.id, { avatarStyle: "shapes" }))?.avatarStyle).toBe(
      "shapes",
    );
    await expect(
      ctx.db.sql`update bots set avatar_style = 'neon' where id = ${pixel.id}`,
    ).rejects.toThrow();
    expect(await migrate(ctx.db)).toEqual([]);
  });
});
