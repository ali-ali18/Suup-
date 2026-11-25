import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chownSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@suup/api";
import { createDb } from "@suup/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEvent, type SidecarEvent } from "../src/protocol.js";

// The packaged layout, started the way the app starts it: the bundle (`sidecar.mjs`), the PostgreSQL
// binaries and the migrations in a resources folder, an empty app-data folder, the secrets in the
// environment. One chat turn with the scripted provider, then a soft stop, and nothing left running.
//
// PostgreSQL refuses to run as root. Where this runs as root (a container), SUUP_TEST_RUN_AS names an
// ordinary user to start the sidecar as.

const HERE = import.meta.dirname;
const SIDECAR = join(HERE, "..");
const RUN_AS = process.env.SUUP_TEST_RUN_AS;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const CAN_RUN = !IS_ROOT || RUN_AS !== undefined;
const TOKEN = "t".repeat(48);

/** The same path with one kind of slash (Windows tools print either), and no case on Windows. */
function samePath(text: string): string {
  const slashed = text.split("\\").join("/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** The processes whose command line has `match` (a path of this test, so nothing else matches). */
function listProcesses(match: string): string[] {
  const wanted = samePath(match);
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { $_.CommandLine }";
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter((line) => line.trim() !== "" && samePath(line).includes(wanted));
  }
  const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(match));
}

describe.skipIf(!CAN_RUN)(
  "the embedded server, from the packaged layout",
  { timeout: 240_000 },
  () => {
    let root = "";
    let resources = "";
    let appData = "";
    let child: ChildProcess | undefined;
    const events: SidecarEvent[] = [];
    let buffered = "";

    const give = (path: string) => {
      if (IS_ROOT && RUN_AS !== undefined) {
        const uid = Number(execFileSync("id", ["-u", RUN_AS], { encoding: "utf8" }));
        execFileSync("chown", ["-R", String(uid), path]);
      }
    };

    /** The tail of the sidecar's and PostgreSQL's logs, printed (and copied to a folder) on failure. */
    const diagnostics = (): string => {
      const logs = join(appData, "logs");
      let text = "";
      try {
        for (const name of readdirSync(logs)) {
          const lines = readFileSync(join(logs, name), "utf8").split("\n");
          text += `\n--- ${name} (últimas linhas) ---\n${lines.slice(-60).join("\n")}`;
        }
      } catch (error) {
        text += `\n(sem logs em ${logs}: ${String(error)})`;
      }
      const keep = process.env.SUUP_TEST_LOGS_DIR;
      if (keep !== undefined) {
        try {
          cpSync(logs, keep, { recursive: true });
        } catch {
          // best effort
        }
      }
      return text;
    };

    const waitFor = (test: (event: SidecarEvent) => boolean, ms: number): Promise<SidecarEvent> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const found = events.find(test);
          if (found !== undefined) {
            clearInterval(timer);
            resolve(found);
          } else if (Date.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timeout; eventos: ${JSON.stringify(events)}\n${diagnostics()}`));
          }
        }, 50);
      });

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "suup-embedded-"));
      // World-readable so the ordinary user can read what root wrote.
      if (process.platform !== "win32") execFileSync("chmod", ["755", root]);
      execFileSync(process.execPath, [join(SIDECAR, "scripts", "prepare.mjs")], {
        env: { ...process.env, SUUP_PREPARE_OUT: root, SUUP_PREPARE_NO_NODE: "1" },
        stdio: "inherit",
      });
      resources = join(root, "resources");
      appData = join(root, "app-data");
      mkdirSync(appData, { recursive: true });
      // The scripted provider instead of a real model: the generated configuration, section replaced.
      writeFileSync(
        join(resources, "script.json"),
        JSON.stringify({
          cases: [
            // First: its conversation also holds the earlier turn (and its answer, step 0).
            {
              whenObjectiveContains: "BUSCA-EMBUTIDA",
              agent: [
                { text: "Olá, de dentro do app." },
                { calls: [{ name: "web_search", args: { query: "suup" } }] },
                { text: "Busquei." },
              ],
            },
            { whenObjectiveContains: "OI-EMBUTIDO", agent: [{ text: "Olá, de dentro do app." }] },
          ],
        }),
      );
      writeFileSync(
        join(appData, "config.override.json"),
        JSON.stringify({
          providers: [
            { id: "scripted", kind: "scripted", scriptPath: join(resources, "script.json") },
          ],
          models: [
            { id: "model-x", provider: "scripted", contextWindow: 100000, maxOutputTokens: 4096 },
          ],
          reviewer: { model: "model-x" },
          memory: { consolidation: { model: "model-x" } },
          // Only an engine Suup asks itself (no Docker, no container started by this test); the
          // network of a test machine may not reach it, which the search reports, not crashes on.
          web: { search: { engines: ["wikipedia"] }, reader: { enabled: false } },
        }),
      );
      give(root);
    });

    afterAll(() => {
      child?.kill("SIGKILL");
    });

    it("starts the database, migrates, serves, answers a chat turn, and stops with nothing left", async () => {
      const env = {
        ...process.env,
        SUUP_APP_DATA: appData,
        SUUP_RESOURCES: resources,
        SUUP_PG_PASSWORD: "senha-do-banco-do-teste-1234",
        SUUP_SERVER_TOKEN: TOKEN,
        SUUP_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        SUUP_SANDBOX: "local",
        SUUP_APP_VERSION: "test",
      };
      const node = process.execPath;
      const bundle = join(resources, "sidecar", "sidecar.mjs");
      const command = RUN_AS !== undefined && IS_ROOT ? "runuser" : node;
      const args =
        RUN_AS !== undefined && IS_ROOT
          ? [
              "-u",
              RUN_AS,
              "--",
              "env",
              ...Object.entries(env)
                .filter(([k]) => k.startsWith("SUUP_"))
                .map(([k, v]) => `${k}=${v}`),
              node,
              bundle,
            ]
          : [bundle];
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
          const event = decodeEvent(buffered.slice(0, at));
          buffered = buffered.slice(at + 1);
          if (event !== undefined) events.push(event);
        }
      });
      let stderr = "";
      child.stderr?.on("data", (c) => {
        stderr += String(c);
      });

      const ready = await waitFor((e) => e.event === "ready" || e.event === "error", 180_000);
      expect(ready, `${JSON.stringify(events)} ${stderr}`).toMatchObject({ event: "ready" });
      if (ready.event !== "ready") return;
      // The stages came in order.
      expect(
        events.filter((e) => e.event === "stage").map((e) => (e as { stage: string }).stage),
      ).toEqual(["database", "migrations", "machine", "server"]);
      expect(ready.isolation.mode).toBe("local");
      expect(ready.url.startsWith("http://127.0.0.1:")).toBe(true);

      const api = createClient({ baseUrl: ready.url, token: TOKEN });
      expect(await api.health()).toEqual({ status: "ok" });
      // The server starts with no bots; the first one is the user's to make.
      expect(await api.bots.list()).toEqual([]);
      const main = await api.bots.create({
        name: "Principal",
        modelId: "model-x",
        allowedTools: (await api.tools.list()).items.map((t) => t.name),
      });
      const conversation = await api.bots.openConversation(main.id);
      await api.conversations.send(conversation.id, "OI-EMBUTIDO");
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { items } = await api.conversations.messages(conversation.id);
        if (items.some((m) => m.authorKind === "bot")) {
          expect(items.at(-1)?.text).toBe("Olá, de dentro do app.");
          break;
        }
        if (Date.now() > deadline) throw new Error("o worker embutido não respondeu");
        await new Promise((r) => setTimeout(r, 50));
      }

      // The web from inside the bundle (docs/BUSCA.md): @suup/web and jsdom load there, and the
      // engines with a public API run with no Docker. The tool's answer is the search's own.
      await api.conversations.send(conversation.id, "BUSCA-EMBUTIDA");
      const searched = Date.now() + 90_000;
      for (;;) {
        const { items } = await api.conversations.messages(conversation.id);
        if (items.at(-1)?.text === "Busquei.") break;
        if (Date.now() > searched) {
          const { items: all } = await api.runs.list({ botId: main?.id as string });
          throw new Error(`a busca embutida não terminou: ${JSON.stringify(all).slice(0, 2000)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const { items: runs } = await api.runs.list({ botId: main?.id as string });
      const results: { content?: unknown; isError?: unknown }[] = [];
      for (const run of runs) {
        const { items } = await api.runs.events(run.id, { types: ["tool_result"] });
        results.push(...items.map((e) => e.payload));
      }
      expect(results.length).toBe(1);
      expect(results[0]?.isError, JSON.stringify(results)).toBe(false);
      expect(String(results[0]?.content)).toContain('Search: "suup"');
      expect(String(results[0]?.content)).toContain("Engines asked: wikipedia");

      // The database is the one in the app-data folder, and only the loopback can reach it.
      expect(readdirSync(join(appData, "postgres"))).toContain("PG_VERSION");
      expect(listProcesses(join(appData, "postgres")).length).toBeGreaterThan(0);

      // A soft stop, the way the app asks: "stop" on stdin.
      child.stdin?.write("stop\n");
      await waitFor((e) => e.event === "stopped", 90_000);
      const code = await new Promise<number | null>((resolve) => {
        if (child?.exitCode !== null && child?.exitCode !== undefined) resolve(child.exitCode);
        else child?.once("exit", (c) => resolve(c));
      });
      expect(code).toBe(0);
      // Nothing is left: no PostgreSQL on this data folder, no Node on this bundle.
      expect(listProcesses(join(appData, "postgres"))).toEqual([]);
      expect(listProcesses(bundle)).toEqual([]);
      // The log is there, and no secret is in it.
      const logs = join(appData, "logs");
      const text = readdirSync(logs)
        .map((name) => readFileSync(join(logs, name), "utf8"))
        .join("\n");
      expect(text).toContain("etapa: server");
      for (const secret of [env.SUUP_PG_PASSWORD, TOKEN, env.SUUP_VAULT_KEY]) {
        expect(text).not.toContain(secret);
      }
      void chownSync;
    });

    it("finds the same ports and the same data on the next start, and stops when the app's pipe closes", async () => {
      const ports = JSON.parse(readFileSync(join(appData, "ports.json"), "utf8")) as {
        server: number;
      };
      const env = {
        ...process.env,
        SUUP_APP_DATA: appData,
        SUUP_RESOURCES: resources,
        SUUP_PG_PASSWORD: "senha-do-banco-do-teste-1234",
        SUUP_SERVER_TOKEN: TOKEN,
        SUUP_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        SUUP_SANDBOX: "local",
        SUUP_APP_VERSION: "test",
      };
      const node = process.execPath;
      const bundle = join(resources, "sidecar", "sidecar.mjs");
      const asRoot = RUN_AS !== undefined && IS_ROOT;
      const args = asRoot
        ? [
            "-u",
            RUN_AS as string,
            "--",
            "env",
            ...Object.entries(env)
              .filter(([k]) => k.startsWith("SUUP_"))
              .map(([k, v]) => `${k}=${v}`),
            node,
            bundle,
          ]
        : [bundle];
      const again = spawn(asRoot ? "runuser" : node, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      again.stdout?.on("data", (c) => {
        out += String(c);
      });
      const deadline = Date.now() + 120_000;
      while (!out.includes('"event":"ready"')) {
        if (Date.now() > deadline) throw new Error(`não subiu: ${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(out).toContain(`http://127.0.0.1:${ports.server}`);
      const api = createClient({ baseUrl: `http://127.0.0.1:${ports.server}`, token: TOKEN });
      const [main] = await api.bots.list();
      const conversation = await api.bots.openConversation(main?.id as string);
      const { items } = await api.conversations.messages(conversation.id);
      expect(items.some((m) => m.text === "Olá, de dentro do app.")).toBe(true);
      // The app dies: its end of the pipe closes. The sidecar stops the server and the database itself.
      again.stdin?.end();
      await new Promise<void>((resolve) => again.once("exit", () => resolve()));
      expect(listProcesses(join(appData, "postgres"))).toEqual([]);
    });

    // An update of the app (docs/ATUALIZACAO.md): the installer replaced the resources, with a new
    // migration, and left the app-data folder alone. The next start migrates the same database and
    // everything that was there is still there.
    it("after an update, the next start applies the new migration to the same data", async () => {
      writeFileSync(
        join(resources, "migrations", "9999_update_probe.sql"),
        "create table update_probe (id int primary key);\n",
      );
      give(resources);
      const env = {
        ...process.env,
        SUUP_APP_DATA: appData,
        SUUP_RESOURCES: resources,
        SUUP_PG_PASSWORD: "senha-do-banco-do-teste-1234",
        SUUP_SERVER_TOKEN: TOKEN,
        SUUP_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        SUUP_SANDBOX: "local",
        SUUP_APP_VERSION: "test-next",
      };
      const node = process.execPath;
      const bundle = join(resources, "sidecar", "sidecar.mjs");
      const asRoot = RUN_AS !== undefined && IS_ROOT;
      const args = asRoot
        ? [
            "-u",
            RUN_AS as string,
            "--",
            "env",
            ...Object.entries(env)
              .filter(([k]) => k.startsWith("SUUP_"))
              .map(([k, v]) => `${k}=${v}`),
            node,
            bundle,
          ]
        : [bundle];
      const next = spawn(asRoot ? "runuser" : node, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      next.stdout?.on("data", (c) => {
        out += String(c);
      });
      try {
        const deadline = Date.now() + 120_000;
        while (!out.includes('"event":"ready"')) {
          if (Date.now() > deadline) throw new Error(`não subiu: ${out}\n${diagnostics()}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        const ports = JSON.parse(readFileSync(join(appData, "ports.json"), "utf8")) as {
          server: number;
          postgres: number;
        };
        const db = createDb(
          `postgres://suup:${env.SUUP_PG_PASSWORD}@127.0.0.1:${ports.postgres}/suup`,
        );
        try {
          const [probe] = await db.sql<{ found: string | null }[]>`
            select to_regclass('update_probe')::text as found`;
          expect(probe?.found).toBe("update_probe");
          const [applied] = await db.sql<{ name: string }[]>`
            select name from schema_migrations where name = '9999_update_probe.sql'`;
          expect(applied?.name).toBe("9999_update_probe.sql");
        } finally {
          await db.close();
        }
        // The conversation of before the update is still there.
        const api = createClient({ baseUrl: `http://127.0.0.1:${ports.server}`, token: TOKEN });
        const [main] = await api.bots.list();
        const conversation = await api.bots.openConversation(main?.id as string);
        const { items } = await api.conversations.messages(conversation.id);
        expect(items.some((m) => m.text === "Olá, de dentro do app.")).toBe(true);
        next.stdin?.write("stop\n");
        await new Promise<void>((resolve) => next.once("exit", () => resolve()));
        expect(listProcesses(join(appData, "postgres"))).toEqual([]);
      } finally {
        if (next.exitCode === null) next.kill("SIGKILL");
      }
    });
  },
);

// The same, with the bots' machine in Docker: the images come from the environment (CI builds them),
// are tagged the way the app tags its own, and a shell command of a bot runs inside the container.
describe.skipIf(!CAN_RUN || process.env.SUUP_DOCKER_TESTS !== "1")(
  "the embedded server with the bots' machine in Docker",
  { timeout: 300_000 },
  () => {
    it("reports Docker isolation and runs a bot's command inside the machine", async () => {
      const sandboxImage = process.env.SUUP_SANDBOX_IMAGE ?? "suup-sandbox:dev";
      const connectorImage = process.env.SUUP_CONNECTOR_IMAGE ?? "suup-connector-runner:dev";
      execFileSync("docker", ["tag", sandboxImage, "suup-sandbox:app-dockertest"]);
      execFileSync("docker", ["tag", connectorImage, "suup-connector-runner:app-dockertest"]);
      // The page reader's image too (its recipe is checked by the web's own Docker tests): built
      // here, it would download a browser of several GB.
      const readerImage = process.env.SUUP_READER_IMAGE ?? "suup-reader:dev";
      execFileSync("docker", ["tag", readerImage, "suup-reader:app-dockertest"]);
      for (const name of ["suup-reader"])
        execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
      // The egress proxy image is NOT tagged here: the sidecar builds it from the Dockerfile and the
      // bundle the app carries, as it does on a first run.
      execFileSync("docker", ["rm", "--force", "suup-egress"], { stdio: "ignore" });
      const root = mkdtempSync(join(tmpdir(), "suup-embedded-docker-"));
      if (process.platform !== "win32") execFileSync("chmod", ["755", root]);
      execFileSync(process.execPath, [join(SIDECAR, "scripts", "prepare.mjs")], {
        env: { ...process.env, SUUP_PREPARE_OUT: root, SUUP_PREPARE_NO_NODE: "1" },
        stdio: "inherit",
      });
      const resources = join(root, "resources");
      const appData = join(root, "app-data");
      mkdirSync(appData, { recursive: true });
      writeFileSync(
        join(resources, "script.json"),
        JSON.stringify({
          cases: [
            // First: its conversation also holds the turn below. The step is the count of the bot's
            // messages so far, so every early step is the search (one or two searches, then the end).
            {
              whenObjectiveContains: "BUSCA-DOCKER",
              agent: [
                { calls: [{ name: "web_search", args: { query: "linux kernel" } }] },
                { calls: [{ name: "web_search", args: { query: "linux kernel" } }] },
                { calls: [{ name: "web_search", args: { query: "linux kernel" } }] },
                { text: "Busquei com o Docker." },
              ],
            },
            {
              whenObjectiveContains: "ROTEIRO-DOCKER",
              agent: [
                {
                  calls: [{ name: "shell", args: { command: "echo dentro-da-maquina; hostname" } }],
                },
                { text: "Rodei na máquina." },
              ],
            },
          ],
        }),
      );
      writeFileSync(
        join(appData, "config.override.json"),
        JSON.stringify({
          providers: [
            { id: "scripted", kind: "scripted", scriptPath: join(resources, "script.json") },
          ],
          models: [
            { id: "model-x", provider: "scripted", contextWindow: 100000, maxOutputTokens: 4096 },
          ],
          reviewer: { model: "model-x" },
          memory: { consolidation: { model: "model-x" } },
        }),
      );
      if (IS_ROOT && RUN_AS !== undefined) {
        const uid = Number(execFileSync("id", ["-u", RUN_AS], { encoding: "utf8" }));
        execFileSync("chown", ["-R", String(uid), root]);
      }
      const env = {
        ...process.env,
        SUUP_APP_DATA: appData,
        SUUP_RESOURCES: resources,
        SUUP_PG_PASSWORD: "senha-do-banco-do-teste-1234",
        SUUP_SERVER_TOKEN: TOKEN,
        SUUP_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        SUUP_APP_VERSION: "dockertest",
      };
      const bundle = join(resources, "sidecar", "sidecar.mjs");
      const asOther = IS_ROOT && RUN_AS !== undefined;
      const args = asOther
        ? [
            "-u",
            RUN_AS as string,
            ...(process.env.SUUP_TEST_RUN_GROUP === undefined
              ? []
              : ["-g", process.env.SUUP_TEST_RUN_GROUP]),
            "--",
            "env",
            ...Object.entries(env)
              .filter(([k]) => k.startsWith("SUUP_"))
              .map(([k, v]) => `${k}=${v}`),
            process.execPath,
            bundle,
          ]
        : [bundle];
      const proc = spawn(asOther ? "runuser" : process.execPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout?.on("data", (c) => {
        out += String(c);
      });
      try {
        const deadline = Date.now() + 200_000;
        while (!out.includes('"event":"ready"') && !out.includes('"event":"error"')) {
          if (Date.now() > deadline) throw new Error(`não subiu: ${out}`);
          await new Promise((r) => setTimeout(r, 200));
        }
        const readyLine = out
          .split("\n")
          .map(decodeEvent)
          .find((e) => e?.event === "ready");
        expect(readyLine, out).toBeDefined();
        if (readyLine?.event !== "ready") return;
        expect(readyLine.isolation).toEqual({ mode: "docker", reason: null, detail: null });
        const api = createClient({ baseUrl: readyLine.url, token: TOKEN });
        const main = await api.bots.create({
          name: "Principal",
          modelId: "model-x",
          allowedTools: (await api.tools.list()).items.map((t) => t.name),
        });
        const conversation = await api.bots.openConversation(main.id);
        await api.conversations.send(conversation.id, "ROTEIRO-DOCKER");
        const until = Date.now() + 120_000;
        for (;;) {
          const { items } = await api.conversations.messages(conversation.id);
          if (items.some((m) => m.text === "Rodei na máquina.")) break;
          // A command may ask for the owner's OK first: say yes, as the owner would in a card.
          for (const card of await api.approvals.list({ status: "pending" })) {
            await api.approvals.decide(card.id, { decision: "approve" });
          }
          if (Date.now() > until) throw new Error("o bot não terminou na máquina isolada");
          await new Promise((r) => setTimeout(r, 200));
        }
        const machine = execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", "suup-machine"],
          { encoding: "utf8" },
        );
        expect(machine.trim()).toBe("true");
        // The proxy runs in its own container and the generated configuration says so; the server
        // (a host process here, as on Windows) is its only controller, through the published port.
        const proxy = execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", "suup-egress"],
          { encoding: "utf8" },
        );
        expect(proxy.trim()).toBe("true");
        const written = JSON.parse(readFileSync(join(appData, "suup.config.json"), "utf8")) as {
          sandbox: { network: { proxy: { mode: string } } };
        };
        expect(written.sandbox.network.proxy.mode).toBe("container");

        // The web search with the bots' machine in Docker: it needs no container of its own (the
        // engines go out through this process's own egress proxy).
        await api.conversations.send(conversation.id, "BUSCA-DOCKER");
        const searched = Date.now() + 240_000;
        for (;;) {
          const { items } = await api.conversations.messages(conversation.id);
          if (items.some((m) => m.text === "Busquei com o Docker.")) break;
          if (Date.now() > searched) throw new Error("a busca com o Docker não terminou");
          await new Promise((r) => setTimeout(r, 200));
        }
        // No container for the search any more: neither SearXNG nor an engine proxy of its own.
        for (const gone of ["suup-searxng", "suup-egress-search"]) {
          const found = execFileSync(
            "docker",
            ["ps", "--all", "--quiet", "--filter", `name=^${gone}$`],
            { encoding: "utf8" },
          );
          expect(found.trim(), gone).toBe("");
        }
        const searchWeb = JSON.parse(readFileSync(join(appData, "suup.config.json"), "utf8")) as {
          web: { search?: { proxy?: unknown }; reader: { image: string } };
        };
        expect(searchWeb.web.search?.proxy).toBeUndefined();
        expect(searchWeb.web.reader.image).toBe("suup-reader:app-dockertest");
      } finally {
        proc.stdin?.write("stop\n");
        await new Promise<void>((resolve) => {
          proc.once("exit", () => resolve());
          setTimeout(() => proc.kill("SIGKILL"), 60_000);
        });
        const left = execFileSync(
          "docker",
          ["ps", "--all", "--quiet", "--filter", "name=^suup-egress$"],
          {
            encoding: "utf8",
          },
        );
        for (const name of ["suup-machine", "suup-egress", "suup-reader"])
          execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
        expect(left.trim(), "o contêiner do proxy deve sumir quando o app para").toBe("");
      }
    });
  },
);
