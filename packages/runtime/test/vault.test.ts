import { SecretUnavailableError } from "@suup/core";
import { createBot, getSecretMeta, listSecretRows } from "@suup/db";
import { describe, expect, it } from "vitest";
import { createVault, generateKeyText, VaultError } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

const VALUE = "ghp_0123456789abcdefghijKLMN";

describe.skipIf(!DATABASE_URL)(dbSuiteName("the vault service"), () => {
  const ctx = useIsolatedDb();
  const make = (env: Record<string, string | undefined>, previous?: string[]) =>
    createVault(() => ctx.db, env, {
      keyEnv: "VAULT_KEY",
      ...(previous === undefined ? {} : { previousKeyEnvs: previous }),
    });
  const newBot = (name: string) => createBot(ctx.db, { name, modelProvider: "p", modelId: "m" });

  it("says plainly when the vault is not configured or the key is missing, naming the variable", async () => {
    const off = createVault(() => ctx.db, {}, undefined);
    expect(off.status()).toMatchObject({ configured: false, ok: false });
    await expect(off.set("X_TOKEN", VALUE)).rejects.toMatchObject({ code: "not_configured" });

    const nokey = make({});
    expect(nokey.status()).toMatchObject({ configured: true, keyEnv: "VAULT_KEY", ok: false });
    expect(nokey.status().reason).toContain("VAULT_KEY");
    await expect(nokey.set("X_TOKEN", VALUE)).rejects.toMatchObject({ code: "key_missing" });
    await expect(nokey.set("X_TOKEN", VALUE)).rejects.toThrow(/VAULT_KEY/);
    await expect(nokey.list()).resolves.toBeDefined(); // metadata needs no key

    const bad = make({ VAULT_KEY: "not-a-key" });
    expect(bad.status().ok).toBe(false);
    await expect(bad.set("X_TOKEN", VALUE)).rejects.toMatchObject({ code: "key_invalid" });
  });

  it("keeps a value encrypted in the database and never lists it", async () => {
    const vault = make({ VAULT_KEY: generateKeyText() });
    const meta = await vault.set("STORED_TOKEN", VALUE, { description: "for the tests" });
    expect(meta).toMatchObject({ name: "STORED_TOKEN", description: "for the tests" });
    expect(JSON.stringify(await vault.list())).not.toContain(VALUE);
    const row = (await listSecretRows(ctx.db)).find((r) => r.name === "STORED_TOKEN");
    expect(row?.ciphertext.toString("latin1")).not.toContain(VALUE);
    expect(row?.ciphertext.toString("hex")).not.toContain(Buffer.from(VALUE).toString("hex"));
    const [dump] = await ctx.db.sql<
      { text: string }[]
    >`select string_agg(s::text, ' ') as text from secrets s`;
    expect(dump?.text).not.toContain(VALUE);
  });

  it("refuses names and values it cannot protect", async () => {
    const vault = make({ VAULT_KEY: generateKeyText() });
    await expect(vault.set("lower_case", VALUE)).rejects.toMatchObject({ code: "value_invalid" });
    await expect(vault.set("SHORT_ONE", "short")).rejects.toThrow(/pelo menos 8/);
    await expect(vault.set("HUGE_ONE", "x".repeat(20_000))).rejects.toBeInstanceOf(VaultError);
  });

  it("hands a value only to a bot that was granted it, and teaches the redactor", async () => {
    const vault = make({ VAULT_KEY: generateKeyText() });
    const allowed = await newBot("allowed");
    const stranger = await newBot("stranger");
    await vault.set("SCOPED_TOKEN", VALUE);
    await vault.grant("SCOPED_TOKEN", allowed.id);

    const access = vault.accessFor(allowed.id);
    expect(await access.resolve(["SCOPED_TOKEN"])).toEqual({ SCOPED_TOKEN: VALUE });
    expect(access.redactor.redact(`x ${VALUE} y`)).toBe("x [REDACTED:SCOPED_TOKEN] y");
    expect((await getSecretMeta(ctx.db, "SCOPED_TOKEN"))?.lastUsedAt).not.toBeNull();

    await expect(vault.accessFor(stranger.id).resolve(["SCOPED_TOKEN"])).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    await expect(access.resolve(["NO_SUCH_SECRET"])).rejects.toBeInstanceOf(SecretUnavailableError);
    // A secret that is not granted looks exactly like one that does not exist.
    const message = (name: string) => access.resolve([name]).catch((e: Error) => e.message);
    expect(await message("NO_SUCH_SECRET")).toBe((await message("NO_SUCH_SECRET")) as string);
    await vault.revoke("SCOPED_TOKEN", allowed.id);
    await expect(access.resolve(["SCOPED_TOKEN"])).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(await vault.infoFor(allowed.id)).toEqual([]);
  });

  it("learns the values another process saved, when refreshed", async () => {
    const key = generateKeyText();
    const writer = make({ VAULT_KEY: key });
    const reader = make({ VAULT_KEY: key });
    await writer.set("SHARED_TOKEN", "value-saved-elsewhere-777");
    expect(reader.redactor.redact("value-saved-elsewhere-777")).toBe("value-saved-elsewhere-777");
    await reader.refresh();
    expect(reader.redactor.redact("value-saved-elsewhere-777")).toBe("[REDACTED:SHARED_TOKEN]");
    // Within the freshness window it does not reload.
    await writer.set("LATER_TOKEN", "value-saved-after-888");
    await reader.refresh(60_000);
    expect(reader.redactor.redact("value-saved-after-888")).toBe("value-saved-after-888");
    await reader.refresh();
    expect(reader.redactor.redact("value-saved-after-888")).toContain("REDACTED");
  });

  it("scrubs a value the moment it is saved, in the process that saved it", async () => {
    const vault = make({ VAULT_KEY: generateKeyText() });
    await vault.set("FRESH_TOKEN", "fresh-value-for-scrubbing-1");
    expect(vault.redactor.redact("a fresh-value-for-scrubbing-1 b")).toContain(
      "REDACTED:FRESH_TOKEN",
    );
  });

  it("rotates to a new key without losing a value, and reports what it cannot read", async () => {
    const oldKey = generateKeyText();
    const newKey = generateKeyText();
    const before = make({ VAULT_KEY: oldKey });
    await before.set("ROTATE_ME", "value-before-rotation-1");
    await before.set("ROTATE_TOO", "value-before-rotation-2");

    // A new key alone cannot read what the old one wrote.
    const alone = make({ VAULT_KEY: newKey });
    expect((await alone.verify()).unreadable).toEqual(
      expect.arrayContaining(["ROTATE_ME", "ROTATE_TOO"]),
    );
    await expect(
      alone.accessFor("00000000-0000-4000-8000-000000000000").resolve(["ROTATE_ME"]),
    ).rejects.toBeDefined();

    // With the old key as a previous one, everything reads, and rotating re-encrypts it.
    const env = { VAULT_KEY: newKey, VAULT_KEY_OLD: oldKey };
    const during = make(env, ["VAULT_KEY_OLD"]);
    const checked = await during.verify();
    expect(checked.unreadable.filter((n) => n.startsWith("ROTATE_"))).toEqual([]);
    expect(checked.onOldKey).toBeGreaterThanOrEqual(2);
    const result = await during.rotate();
    expect(result.rotated).toBeGreaterThanOrEqual(2);
    expect(result.failed.filter((n) => n.startsWith("ROTATE_"))).toEqual([]);
    expect(await during.rotate()).toMatchObject({ rotated: 0 });

    // Afterwards the new key is enough, and the old one reads nothing.
    const after = make({ VAULT_KEY: newKey });
    expect((await after.verify()).unreadable.filter((n) => n.startsWith("ROTATE_"))).toEqual([]);
    expect((await make({ VAULT_KEY: oldKey }).verify()).unreadable).toEqual(
      expect.arrayContaining(["ROTATE_ME", "ROTATE_TOO"]),
    );
    const bot = await newBot("rotated");
    await after.grant("ROTATE_ME", bot.id);
    expect(await after.accessFor(bot.id).resolve(["ROTATE_ME"])).toEqual({
      ROTATE_ME: "value-before-rotation-1",
    });
  });

  it("removes a secret", async () => {
    const vault = make({ VAULT_KEY: generateKeyText() });
    await vault.set("REMOVED_TOKEN", VALUE);
    expect(await vault.remove("REMOVED_TOKEN")).toBe(true);
    expect(await vault.remove("REMOVED_TOKEN")).toBe(false);
  });
});
