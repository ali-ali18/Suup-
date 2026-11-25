import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adoptSecret,
  checkSecretHosts,
  createBot,
  deleteSecret,
  getSecretHosts,
  getSecretMeta,
  getSecretRowForBot,
  grantSecret,
  listSecretInfoForBot,
  listSecretRows,
  listSecretRowsForBot,
  listSecrets,
  putSecret,
  replaceSecretCipher,
  revokeSecret,
  SecretHostInvalidError,
  SecretManagedError,
  SecretNotFoundError,
  setSecretHosts,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("the vault's rows"), () => {
  const ctx = useIsolatedDb();
  const cipher = () => ({ nonce: randomBytes(12), ciphertext: randomBytes(40), keyId: "key-aaaa" });
  const newBot = (name: string) => createBot(ctx.db, { name, modelProvider: "p", modelId: "m" });

  it("stores ciphertext and answers with metadata only: nothing in the listing can be a value", async () => {
    const meta = await putSecret(ctx.db, {
      name: "GITHUB_TOKEN",
      description: "push access",
      ...cipher(),
    });
    expect(meta).toMatchObject({
      name: "GITHUB_TOKEN",
      description: "push access",
      keyId: "key-aaaa",
      grantedBotIds: [],
      lastUsedAt: null,
    });
    expect(Object.keys(meta).sort()).toEqual([
      "createdAt",
      "description",
      "grantedBotIds",
      "hosts",
      "id",
      "keyId",
      "lastUsedAt",
      "managedBy",
      "name",
      "updatedAt",
    ]);
    const listed = await listSecrets(ctx.db);
    expect(listed.map((s) => s.name)).toContain("GITHUB_TOKEN");
    for (const s of listed) {
      expect(Object.keys(s)).not.toContain("ciphertext");
      expect(Object.keys(s)).not.toContain("nonce");
    }
  });

  it("replaces the value and keeps the grants; keeps or changes the description as asked", async () => {
    const bot = await newBot("owner");
    await putSecret(ctx.db, { name: "REPLACED", description: "first", ...cipher() });
    await grantSecret(ctx.db, "REPLACED", bot.id);
    const before = (await listSecretRows(ctx.db)).find((r) => r.name === "REPLACED");
    const next = cipher();
    const after = await putSecret(ctx.db, { name: "REPLACED", ...next });
    expect(after.description).toBe("first");
    expect(after.grantedBotIds).toEqual([bot.id]);
    const row = (await listSecretRows(ctx.db)).find((r) => r.name === "REPLACED");
    expect(row?.ciphertext.equals(next.ciphertext)).toBe(true);
    expect(row?.ciphertext.equals(before?.ciphertext as Buffer)).toBe(false);
    expect(
      (await putSecret(ctx.db, { name: "REPLACED", description: "second", ...cipher() }))
        .description,
    ).toBe("second");
  });

  it("refuses names the model could not write as a placeholder", async () => {
    for (const bad of ["lower", "1ST", "HAS SPACE", "A-B", "", "X".repeat(65)]) {
      await expect(putSecret(ctx.db, { name: bad, ...cipher() })).rejects.toThrow();
    }
  });

  it("lets only the granted bots read a secret's row", async () => {
    const allowed = await newBot("allowed");
    const stranger = await newBot("stranger");
    await putSecret(ctx.db, { name: "SCOPED", description: "d", ...cipher() });
    await grantSecret(ctx.db, "SCOPED", allowed.id);
    await grantSecret(ctx.db, "SCOPED", allowed.id); // idempotent
    expect((await getSecretRowForBot(ctx.db, allowed.id, "SCOPED"))?.name).toBe("SCOPED");
    expect(await getSecretRowForBot(ctx.db, stranger.id, "SCOPED")).toBeNull();
    expect((await listSecretRowsForBot(ctx.db, allowed.id)).map((r) => r.name)).toEqual(["SCOPED"]);
    expect(await listSecretInfoForBot(ctx.db, allowed.id)).toEqual([
      { name: "SCOPED", description: "d", hosts: [] },
    ]);
    expect(await listSecretInfoForBot(ctx.db, stranger.id)).toEqual([]);
    expect(await revokeSecret(ctx.db, "SCOPED", allowed.id)).toBe(true);
    expect(await revokeSecret(ctx.db, "SCOPED", allowed.id)).toBe(false);
    expect(await getSecretRowForBot(ctx.db, allowed.id, "SCOPED")).toBeNull();
  });

  it("refuses to grant a secret that does not exist", async () => {
    const bot = await newBot("b");
    await expect(grantSecret(ctx.db, "MISSING", bot.id)).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
  });

  it("deleting a secret takes its grants with it", async () => {
    const bot = await newBot("gone");
    await putSecret(ctx.db, { name: "TEMPORARY", ...cipher() });
    await grantSecret(ctx.db, "TEMPORARY", bot.id);
    expect(await deleteSecret(ctx.db, "TEMPORARY")).toBe(true);
    expect(await deleteSecret(ctx.db, "TEMPORARY")).toBe(false);
    expect(await getSecretMeta(ctx.db, "TEMPORARY")).toBeNull();
    const [grants] = await ctx.db.sql<
      { n: string }[]
    >`select count(*) as n from secret_grants where bot_id = ${bot.id}`;
    expect(Number(grants?.n)).toBe(0);
  });

  it("replaces a ciphertext only if the row did not change meanwhile (rotation)", async () => {
    await putSecret(ctx.db, { name: "ROTATING", ...cipher() });
    const row = (await listSecretRows(ctx.db)).find((r) => r.name === "ROTATING");
    if (row === undefined) throw new Error("missing");
    expect(await replaceSecretCipher(ctx.db, row, { ...cipher(), keyId: "key-bbbb" })).toBe(true);
    // The row changed under the old snapshot: a second attempt from it must lose.
    expect(await replaceSecretCipher(ctx.db, row, { ...cipher(), keyId: "key-cccc" })).toBe(false);
    expect((await getSecretMeta(ctx.db, "ROTATING"))?.keyId).toBe("key-bbbb");
  });

  it("rejects a nonce of the wrong size", async () => {
    await expect(
      putSecret(ctx.db, {
        name: "BADNONCE",
        nonce: randomBytes(8),
        ciphertext: randomBytes(20),
        keyId: "k",
      }),
    ).rejects.toThrow();
  });

  it("a secret a connector keeps is hidden, never granted, never edited by the owner", async () => {
    const bot = await newBot("managed-owner");
    await putSecret(ctx.db, { name: "SUUP_OAUTH_X_ACCESS", managedBy: "x", ...cipher() });
    await putSecret(ctx.db, { name: "OWNERS_OWN", ...cipher() });
    expect((await listSecrets(ctx.db)).map((s) => s.name)).not.toContain("SUUP_OAUTH_X_ACCESS");
    expect((await listSecrets(ctx.db)).map((s) => s.name)).toContain("OWNERS_OWN");
    expect(
      (await listSecrets(ctx.db, { includeManaged: true })).find(
        (s) => s.name === "SUUP_OAUTH_X_ACCESS",
      )?.managedBy,
    ).toBe("x");
    await expect(grantSecret(ctx.db, "SUUP_OAUTH_X_ACCESS", bot.id)).rejects.toThrow(
      SecretManagedError,
    );
    await expect(putSecret(ctx.db, { name: "SUUP_OAUTH_X_ACCESS", ...cipher() })).rejects.toThrow(
      SecretManagedError,
    );
    await expect(
      putSecret(ctx.db, { name: "OWNERS_OWN", managedBy: "x", ...cipher() }),
    ).rejects.toThrow(SecretManagedError);
    expect(await deleteSecret(ctx.db, "SUUP_OAUTH_X_ACCESS")).toBe(false);
    expect(await deleteSecret(ctx.db, "SUUP_OAUTH_X_ACCESS", "y")).toBe(false);
    expect(await deleteSecret(ctx.db, "SUUP_OAUTH_X_ACCESS", "x")).toBe(true);
  });

  it("adopting hands an owner's secret to its plugin: marked, hidden, grants gone, value kept", async () => {
    const bot = await newBot("adopt-owner");
    const put = await putSecret(ctx.db, { name: "ADOPT_ME", ...cipher() });
    await grantSecret(ctx.db, "ADOPT_ME", bot.id);
    expect(await adoptSecret(ctx.db, "ADOPT_ME", "github")).toBe(true);
    const meta = await getSecretMeta(ctx.db, "ADOPT_ME");
    expect(meta).toMatchObject({ managedBy: "github", grantedBotIds: [], keyId: put.keyId });
    expect((await listSecrets(ctx.db)).map((s) => s.name)).not.toContain("ADOPT_ME");
    expect(await listSecretRowsForBot(ctx.db, bot.id)).toEqual([]);
    expect(await getSecretRowForBot(ctx.db, bot.id, "ADOPT_ME")).toBeNull();
  });

  it("adopting is idempotent and never takes a secret another plugin keeps or one that is absent", async () => {
    await putSecret(ctx.db, { name: "KEPT_BY_A", managedBy: "a", ...cipher() });
    expect(await adoptSecret(ctx.db, "KEPT_BY_A", "b")).toBe(false);
    expect((await getSecretMeta(ctx.db, "KEPT_BY_A"))?.managedBy).toBe("a");
    expect(await adoptSecret(ctx.db, "KEPT_BY_A", "a")).toBe(false);
    expect(await adoptSecret(ctx.db, "NOT_THERE", "a")).toBe(false);
    await putSecret(ctx.db, { name: "TWICE", ...cipher() });
    expect(await adoptSecret(ctx.db, "TWICE", "search:tavily")).toBe(true);
    expect(await adoptSecret(ctx.db, "TWICE", "search:tavily")).toBe(false);
    expect((await getSecretMeta(ctx.db, "TWICE"))?.managedBy).toBe("search:tavily");
  });

  describe("the hosts a secret may go to", () => {
    it("a new secret has none (it is blocked); hosts are normalized and replaced as a whole", async () => {
      expect((await putSecret(ctx.db, { name: "HOSTLESS", ...cipher() })).hosts).toEqual([]);
      const set = await setSecretHosts(ctx.db, "HOSTLESS", ["API.Exemplo.com.", "b.exemplo.com"]);
      expect(set.hosts).toEqual(["api.exemplo.com", "b.exemplo.com"]);
      // Replacing the value keeps the hosts; writing with hosts replaces them.
      expect((await putSecret(ctx.db, { name: "HOSTLESS", ...cipher() })).hosts).toEqual([
        "api.exemplo.com",
        "b.exemplo.com",
      ]);
      expect(
        (await putSecret(ctx.db, { name: "HOSTLESS", hosts: ["c.exemplo.com"], ...cipher() }))
          .hosts,
      ).toEqual(["c.exemplo.com"]);
      expect((await setSecretHosts(ctx.db, "HOSTLESS", [])).hosts).toEqual([]);
      expect((await listSecrets(ctx.db)).find((s) => s.name === "HOSTLESS")?.hosts).toEqual([]);
    });

    it("only a plain DNS name is a host: no scheme, port, path, wildcard, IP address or odd label", () => {
      expect(checkSecretHosts(["A.b.test", "a.b.test", "localhost"])).toEqual([
        "a.b.test",
        "localhost",
      ]);
      for (const bad of [
        "",
        " ",
        "https://a.b.test",
        "a.b.test:8443",
        "a.b.test/path",
        "*.b.test",
        "a b.test",
        "10.0.0.1",
        "0x7f.1",
        "[::1]",
        "a..b.test",
        "-a.b.test",
        "a-.b.test",
        "a_b.test",
        `${"x".repeat(64)}.test`,
      ]) {
        expect(() => checkSecretHosts([bad]), JSON.stringify(bad)).toThrow(SecretHostInvalidError);
      }
    });

    it("the table itself refuses anything but a lower-case DNS name", async () => {
      const meta = await putSecret(ctx.db, { name: "CHECKED", ...cipher() });
      for (const bad of ["UPPER.test", "a b.test", "a.test/x", "*.a.test", ".a.test", "a.test."]) {
        await expect(
          ctx.db.sql`insert into secret_hosts (secret_id, host)
                     select id, ${bad} from secrets where name = ${meta.name}`,
        ).rejects.toThrow();
      }
    });

    it("refuses to touch a plugin's secret, a missing one, and drops the hosts with an adopted one", async () => {
      await putSecret(ctx.db, { name: "PLUGIN_OWNED", managedBy: "x", ...cipher() });
      await expect(setSecretHosts(ctx.db, "PLUGIN_OWNED", ["a.b.test"])).rejects.toThrow(
        SecretManagedError,
      );
      await expect(setSecretHosts(ctx.db, "NOT_THERE", ["a.b.test"])).rejects.toThrow(
        SecretNotFoundError,
      );
      await putSecret(ctx.db, { name: "TO_ADOPT", hosts: ["a.b.test"], ...cipher() });
      await adoptSecret(ctx.db, "TO_ADOPT", "github");
      expect(await getSecretHosts(ctx.db, ["TO_ADOPT", "PLUGIN_OWNED"])).toEqual({});
    });

    it("answers the hosts of the named secrets only, and for a bot only the ones it was granted", async () => {
      const bot = await newBot("hosts-bot");
      const other = await newBot("hosts-other");
      await putSecret(ctx.db, { name: "MINE", hosts: ["a.b.test"], ...cipher() });
      await putSecret(ctx.db, { name: "BLOCKED_ONE", ...cipher() });
      await putSecret(ctx.db, { name: "NOT_GRANTED", hosts: ["z.b.test"], ...cipher() });
      await grantSecret(ctx.db, "MINE", bot.id);
      await grantSecret(ctx.db, "BLOCKED_ONE", bot.id);
      await grantSecret(ctx.db, "NOT_GRANTED", other.id);
      expect(await getSecretHosts(ctx.db, [])).toEqual({});
      expect(
        await getSecretHosts(ctx.db, ["MINE", "BLOCKED_ONE", "NOT_GRANTED", "MISSING"], bot.id),
      ).toEqual({
        MINE: ["a.b.test"],
        BLOCKED_ONE: [],
      });
      expect(await listSecretInfoForBot(ctx.db, bot.id)).toEqual([
        { name: "BLOCKED_ONE", description: "", hosts: [] },
        { name: "MINE", description: "", hosts: ["a.b.test"] },
      ]);
    });

    it("deleting a secret takes its hosts with it", async () => {
      await putSecret(ctx.db, { name: "DOOMED", hosts: ["a.b.test"], ...cipher() });
      await deleteSecret(ctx.db, "DOOMED");
      const [count] = await ctx.db.sql<
        { n: string }[]
      >`select count(*) as n from secret_hosts where host = 'a.b.test' and secret_id not in (select id from secrets)`;
      expect(Number(count?.n)).toBe(0);
    });
  });
});
