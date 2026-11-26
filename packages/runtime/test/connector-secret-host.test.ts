import { join } from "node:path";
import { startFakeHttpServer } from "@suup/connectors/testing";
import { SecretDestinationRefusedError } from "@suup/core";
import { getSecretMeta } from "@suup/db";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, generateKeyText, parseConfig, type Runtime } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// Made-up values, only for these tests.
const VALUE = "tok_made_up_for_kod36_tests_0001";
const OTHER = "tok_made_up_for_kod36_tests_0002";

// KOD-36: a connector configured by hand that names a user's secret only connects when the host of
// its address is in that secret's list, the same rule `web_fetch` follows (KOD-30).
describe.skipIf(!DATABASE_URL)(
  dbSuiteName("a connector's address and the hosts of its secrets"),
  { timeout: 60_000 },
  () => {
    const ctx = useIsolatedDb();
    let runtime: Runtime | undefined;
    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
    });

    async function open(): Promise<Runtime> {
      await ctx.db.sql`delete from connectors`;
      await ctx.db.sql`delete from secrets`;
      const dir = await tempDir();
      await writeJson(join(dir, "script.json"), { agent: [{ text: "ok" }] });
      const env = { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() };
      runtime = createRuntime(parseConfig(rawConfig({ vault: { keyEnv: "TEST_VAULT_KEY" } })), {
        env,
        baseDir: dir,
      });
      return runtime;
    }

    async function connectorAt(rt: Runtime, url: string): Promise<void> {
      await rt.connectors.create({
        name: "manual",
        transport: {
          kind: "http",
          url,
          headers: { Authorization: { secret: "API_TOKEN", prefix: "Bearer " } },
        },
      });
    }

    it("a secret bound to another host: the connection is refused, and the server never gets the value (nor any request)", async () => {
      const rt = await open();
      const server = await startFakeHttpServer();
      try {
        await rt.vault.set("API_TOKEN", VALUE, { hosts: ["api.outro.test"] });
        await connectorAt(rt, server.url.replace("127.0.0.1", "localhost"));
        const result = await rt.connectors.test("manual");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("a conexão foi recusada");
        expect(result.error).toContain("só pode ir para api.outro.test, não para localhost");
        expect(result.error).not.toContain(VALUE);
        expect(server.authorizations).toEqual([]);
        // The value was never read for it: the vault did not mark it used.
        expect((await getSecretMeta(rt.db, "API_TOKEN"))?.lastUsedAt).toBeNull();
      } finally {
        await server.close();
      }
    });

    it("a secret with no hosts is blocked for a connector too", async () => {
      const rt = await open();
      const server = await startFakeHttpServer();
      try {
        await rt.vault.set("API_TOKEN", VALUE);
        await connectorAt(rt, server.url.replace("127.0.0.1", "localhost"));
        const result = await rt.connectors.test("manual");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("ainda não tem endereços declarados");
        expect(server.authorizations).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("an address with no site name (an IP address) cannot be checked, so it is refused", async () => {
      const rt = await open();
      const server = await startFakeHttpServer();
      try {
        await rt.vault.set("API_TOKEN", VALUE, { hosts: ["localhost"] });
        await connectorAt(rt, server.url);
        const result = await rt.connectors.test("manual");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("não tem um nome de site");
        expect(server.authorizations).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("the host of the address in the secret's list: it connects with the value in the header", async () => {
      const rt = await open();
      const server = await startFakeHttpServer({ requireAuthorization: `Bearer ${VALUE}` });
      try {
        await rt.vault.set("API_TOKEN", VALUE, { hosts: ["api.outro.test", "localhost"] });
        await connectorAt(rt, server.url.replace("127.0.0.1", "localhost"));
        const result = await rt.connectors.test("manual");
        expect(result.error).toBeNull();
        expect(result.ok).toBe(true);
        expect(server.authorizations).toContain(`Bearer ${VALUE}`);
      } finally {
        await server.close();
      }
    });

    it("the vault checks every name before reading any value", async () => {
      const rt = await open();
      await rt.vault.set("FIRST_TOKEN", VALUE, { hosts: ["mcp.exemplo.test"] });
      await rt.vault.set("SECOND_TOKEN", OTHER, { hosts: ["api.outro.test"] });
      await expect(
        rt.vault.resolveForConnector(["FIRST_TOKEN", "SECOND_TOKEN"], {
          kind: "host",
          host: "mcp.exemplo.test",
        }),
      ).rejects.toBeInstanceOf(SecretDestinationRefusedError);
      // The first one was fine, and still was not read.
      expect((await getSecretMeta(rt.db, "FIRST_TOKEN"))?.lastUsedAt).toBeNull();
      const ok = await rt.vault.resolveForConnector(["FIRST_TOKEN"], {
        kind: "host",
        host: "mcp.exemplo.test",
      });
      expect(ok.FIRST_TOKEN).toBe(VALUE);
    });
  },
);
