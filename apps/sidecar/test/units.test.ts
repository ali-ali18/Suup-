import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { createLogger, logFileName, pruneLogs, scrubber } from "../src/log.js";
import { choosePorts, portIsFree } from "../src/ports.js";
import { decodeEvent, encodeEvent } from "../src/protocol.js";
import { readEnv } from "../src/run.js";

const tmp = () => mkdtempSync(join(tmpdir(), "suup-sidecar-unit-"));

describe("log", () => {
  it("scrubs known secret values by exact match, and leaves short ones alone", () => {
    const scrub = scrubber(["segredo-comprido-123", "abc", undefined]);
    expect(scrub("a chave é segredo-comprido-123, e abc fica")).toBe(
      "a chave é [segredo], e abc fica",
    );
  });

  it("writes one file per day, scrubbed, and keeps only the newest ones", () => {
    const dir = tmp();
    const logger = createLogger(join(dir, "logs"), scrubber(["valor-secreto-9999"]));
    logger.line("usando valor-secreto-9999 agora");
    const name = logFileName(new Date());
    const text = readFileSync(join(logger.dir, name), "utf8");
    expect(text).toContain("usando [segredo] agora");
    expect(text).not.toContain("valor-secreto-9999");
    for (let day = 1; day <= 20; day++) {
      writeFileSync(join(logger.dir, `suup-2020-01-${String(day).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logger.dir, "postgres.log"), "x");
    pruneLogs(logger.dir, 5);
    const left = readdirSync(logger.dir).filter((n) => n.startsWith("suup-"));
    expect(left.length).toBe(5);
    expect(readdirSync(logger.dir)).toContain("postgres.log");
    expect(left).toContain(name);
  });
});

describe("ports", () => {
  it("keeps the chosen ports between starts, and replaces one that is taken", async () => {
    const file = join(tmp(), "ports.json");
    const first = await choosePorts(file);
    expect(first.server).not.toBe(first.postgres);
    expect(await choosePorts(file)).toEqual(first);
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(first.server, "127.0.0.1", r));
    try {
      expect(await portIsFree(first.server)).toBe(false);
      const moved = await choosePorts(file);
      expect(moved.server).not.toBe(first.server);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe("protocol", () => {
  it("reads back what it writes, and ignores stray lines", () => {
    const line = encodeEvent({ event: "stage", stage: "database" });
    expect(decodeEvent(line.trim())).toEqual({ event: "stage", stage: "database" });
    expect(decodeEvent("não é json")).toBeUndefined();
    expect(decodeEvent('{"event":"outra"}')).toBeUndefined();
  });
});

describe("config", () => {
  const base = {
    workspace: "/w",
    images: { sandbox: "s:1", connectors: "c:1", egress: "e:1", reader: "r:1" },
    egress: "container" as const,
    networkName: "net",
    allowedOrigins: [],
  };
  it("names the variables with the secrets and never holds one", () => {
    const text = JSON.stringify(
      buildConfig({ ...base, isolation: { mode: "docker", reason: null, detail: null } }),
    );
    for (const name of ["ANTHROPIC_API_KEY", "SUUP_SERVER_TOKEN", "SUUP_VAULT_KEY"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("sk-");
    expect(text).toContain('"kind":"docker"');
    expect(text).toContain('"proxy":{"mode":"container","image":"e:1"}');
  });
  it("runs the bots on this computer, in its own folder, when there is no Docker", () => {
    const config = buildConfig({
      ...base,
      isolation: { mode: "local", reason: "docker_missing", detail: null },
    }) as { sandbox: { kind: string; root: string } };
    expect(config.sandbox).toEqual({ kind: "local", root: "/w" });
  });
  it("gives the web the reader, and no search container or proxy: the search needs no Docker", () => {
    const docker = { mode: "docker", reason: null, detail: null } as const;
    const web = (config: Record<string, unknown>) => config.web;
    // Whatever the bots' proxy is (a container on Windows, this process on a Linux host).
    expect(web(buildConfig({ ...base, isolation: docker }))).toEqual({
      reader: { image: "r:1" },
    });
    expect(web(buildConfig({ ...base, egress: "process", isolation: docker }))).toEqual({
      reader: { image: "r:1" },
    });
    // No Docker: the engines with a public API and the queue of general ones, pages read in this process.
    expect(
      web(
        buildConfig({
          ...base,
          egress: null,
          isolation: { mode: "local", reason: "docker_missing", detail: null },
        }),
      ),
    ).toEqual({ reader: { image: "r:1" } });
  });
  it("sends the computer's locale to the web search, so a Brazilian gets Brazil and Portuguese", () => {
    expect(
      (
        buildConfig({
          ...base,
          isolation: { mode: "docker", reason: null, detail: null },
          locale: "pt-BR",
        }) as { web: unknown }
      ).web,
    ).toEqual({
      search: { locale: "pt-BR" },
      reader: { image: "r:1" },
    });
  });
});

describe("environment", () => {
  it("names the missing variable, never a value", () => {
    expect(() => readEnv({})).toThrow("SUUP_APP_DATA");
    const ok = readEnv({
      SUUP_APP_DATA: "/d",
      SUUP_RESOURCES: "/r",
      SUUP_PG_PASSWORD: "p",
      SUUP_SERVER_TOKEN: "t",
      SUUP_VAULT_KEY: "k",
    });
    expect(ok.apiKey).toBeUndefined();
    expect(ok.sandbox).toBe("auto");
    mkdirSync(join(tmp(), "x"));
  });
});
