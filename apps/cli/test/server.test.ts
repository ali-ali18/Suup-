import { createServer as createNetServer } from "node:net";
import { createClient } from "@suup/api";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, runCli, useProject } from "./harness.js";

// `suup server`: the token rules and `--generate-token` need no database; the real thing (the API
// answering, the embedded worker finishing a run, the clean shutdown) does.

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe("suup server --generate-token", () => {
  it("prints a new random token, one per line, and needs no configuration", async () => {
    const a = await runCli(["server", "--generate-token"]);
    const b = await runCli(["server", "--generate-token"]);
    expect(a.code).toBe(0);
    expect(a.stderr).toBe("");
    expect(a.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(a.stdout).not.toBe(b.stdout);
    const json = await runCli(["server", "--generate-token", "--json"]);
    expect((JSON.parse(json.stdout) as { token: string }).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is documented in the command's help", async () => {
    const r = await runCli(["help", "server"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--generate-token");
    expect(r.stdout).toContain("--with-worker");
    expect(r.stdout).toContain("tauri://localhost");
    expect(r.stdout).toContain("TLS");
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup server, end to end"), () => {
  const p = useProject();
  const token = "t".repeat(48);

  it("refuses to start without a token, or with a short one, and names the variable", async () => {
    await p.suup(["db", "migrate"]);
    const missing = await p.suup(["server", "--port", "1"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("SUUP_SERVER_TOKEN");
    expect(missing.stderr).toContain("--generate-token");
    const short = await p.suup(["server", "--port", "1"], { env: { SUUP_SERVER_TOKEN: "curto" } });
    expect(short.code).toBe(1);
    expect(short.stderr).toContain("5 caracteres");

    // The variable is the one the configuration names; the token itself is never in the file.
    await p.config({ server: { tokenEnv: "MEU_TOKEN" } });
    const other = await p.suup(["server", "--port", "1"], { env: { SUUP_SERVER_TOKEN: token } });
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("MEU_TOKEN");
    const rejected = await p.suup(["server", "--port", "1"], {
      env: { MEU_TOKEN: "x".repeat(10) },
    });
    expect(rejected.code).toBe(1);
    await p.config();
  });

  it("refuses a configuration with a token inside it", async () => {
    await p.config({ server: { token: token } });
    const r = await p.suup(["server", "--port", "1"], { env: { SUUP_SERVER_TOKEN: token } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("token");
    await p.config();
  });

  it("serves the API with an embedded worker, and stops cleanly on the first Ctrl+C", async () => {
    await p.script("roteiro.json", {
      cases: [{ whenObjectiveContains: "OI-SERVIDOR", agent: [{ text: "Olá pelo servidor." }] }],
    });
    await p.script("outro.json", { agent: [] });
    await p.config({ server: { allowedOrigins: ["tauri://localhost"] } });
    const port = await freePort();
    const result = await p.suup(["server", "--port", String(port), "--with-worker"], {
      env: { SUUP_SERVER_TOKEN: token },
      async during(handle) {
        await handle.waitFor("Servidor no ar em", 30_000);
        const api = createClient({ baseUrl: `http://127.0.0.1:${port}`, token });
        expect(await api.health()).toEqual({ status: "ok" });
        // The main bot was created at start, and the embedded worker answers.
        const [main] = await api.bots.list();
        expect(main?.name).toBe("Principal");
        const conversation = await api.bots.openConversation(main?.id as string);
        await api.conversations.send(conversation.id, "OI-SERVIDOR");
        const deadline = Date.now() + 30_000;
        for (;;) {
          const { items } = await api.conversations.messages(conversation.id);
          if (items.some((m) => m.authorKind === "bot")) {
            expect(items.at(-1)?.text).toBe("Olá pelo servidor.");
            break;
          }
          if (Date.now() > deadline) throw new Error("the embedded worker did not answer");
          await new Promise((r) => setTimeout(r, 25));
        }
        handle.interrupt();
        await handle.waitFor("Servidor parado.", 30_000);
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`http://127.0.0.1:${port}`);
    expect(result.stdout).toContain("com o worker");
    expect(result.stdout).toContain("Bot principal criado");
    // No token anywhere in what it prints.
    expect(result.stdout + result.stderr).not.toContain(token);
    // Binding to loopback by default: no warning about exposure.
    expect(result.stdout + result.stderr).not.toContain("HTTP puro");
  });

  it("warns when it listens beyond this computer, and says a worker is still needed without --with-worker", async () => {
    const port = await freePort();
    const result = await p.suup(["server", "--port", String(port), "--host", "0.0.0.0"], {
      env: { SUUP_SERVER_TOKEN: token },
      async during(handle) {
        await handle.waitFor("Servidor no ar em", 30_000);
        handle.interrupt();
        await handle.waitFor("Servidor parado.", 30_000);
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("AVISO");
    expect(result.stderr).toContain("TLS");
    expect(result.stdout).toContain("rode `suup worker`");
  });

  it("reports a port already in use", async () => {
    const port = await freePort();
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      const r = await p.suup(["server", "--port", String(port)], {
        env: { SUUP_SERVER_TOKEN: token },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`porta ${port}`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
