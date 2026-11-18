import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutor, ensureMachine, removeMachine } from "../src/index.js";
import { describeExecutorContract } from "./executor-contract.js";
import { installFakeDocker } from "./fake-docker.js";

const REAL = process.env.SUUP_DOCKER_TESTS === "1";
const IMAGE = process.env.SUUP_SANDBOX_IMAGE;

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suup-docker-test-"));
  temps.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------
// With a fake `docker` binary: always runs. Covers argv construction, the in-container scripts
// (executed locally) and the exit code protocol. Does NOT prove anything about real Docker.
// ---------------------------------------------------------------------------------------------

describe("DockerExecutor with a fake docker CLI", () => {
  let binDir: string;
  let dockerPath: string;
  let logFile: string;
  let stateFile: string;
  const saved = { log: process.env.FAKE_DOCKER_LOG, state: process.env.FAKE_DOCKER_STATE };

  beforeAll(async () => {
    binDir = await tempDir();
    dockerPath = installFakeDocker(binDir);
    logFile = join(binDir, "calls.log");
    stateFile = join(binDir, "state.json");
    process.env.FAKE_DOCKER_LOG = logFile;
    process.env.FAKE_DOCKER_STATE = stateFile;
  });
  afterAll(() => {
    for (const [key, value] of [
      ["FAKE_DOCKER_LOG", saved.log],
      ["FAKE_DOCKER_STATE", saved.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function calls(): Promise<string[][]> {
    const text = await readFile(logFile, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  }

  describeExecutorContract("DockerExecutor (fake docker CLI)", async () => {
    const base = await tempDir();
    const workspace = join(base, "workspace");
    const outsideDir = join(base, "outside");
    await mkdir(workspace);
    await mkdir(outsideDir);
    return {
      executor: new DockerExecutor({ container: "fake", workspace, dockerPath }),
      root: workspace,
      outsideDir,
      async dispose() {},
    };
  });

  describe("host-side safety", () => {
    beforeEach(async () => {
      await rm(logFile, { force: true });
    });

    it("passes hostile model-controlled values as single argv elements", async () => {
      const workspace = await tempDir();
      const ex = new DockerExecutor({ container: "fake", workspace, dockerPath, user: "bot" });
      const command = "echo $(id) `id`; echo '\"' ; false";
      await ex.exec(command, { env: { SOME_VAR: 'a b; $(c) "d"' } });
      await ex.writeFile("it's $(x).txt", "content with $(y) and 'quotes'");
      const all = await calls();
      const execCall = all[0] as string[];
      expect(execCall.slice(0, 3)).toEqual(["exec", "-u", "bot"]);
      expect(execCall).toContain(command);
      expect(execCall).toContain('SOME_VAR=a b; $(c) "d"');
      const fileCall = all[1] as string[];
      expect(fileCall).toContain(`${workspace}/it's $(x).txt`);
      // content travels on stdin, never in argv
      expect(JSON.stringify(fileCall)).not.toContain("content with");
    });

    it("rejects invalid environment variable names and NUL bytes", async () => {
      const workspace = await tempDir();
      const ex = new DockerExecutor({ container: "fake", workspace, dockerPath });
      await expect(ex.exec("true", { env: { "BAD=NAME": "x" } })).rejects.toThrow(
        /invalid environment/,
      );
      await expect(ex.exec("true", { env: { "-x": "x" } })).rejects.toThrow(/invalid environment/);
      await expect(ex.exec("true\0")).rejects.toThrow(/NUL/);
    });

    it("validates constructor arguments", () => {
      expect(() => new DockerExecutor({ container: "--privileged", dockerPath })).toThrow();
      expect(() => new DockerExecutor({ container: "c", workspace: "relative" })).toThrow();
      expect(() => new DockerExecutor({ container: "c", workspace: "/" })).toThrow();
      expect(() => new DockerExecutor({ container: "c", user: "bot; rm -rf /" })).toThrow();
    });

    it("explains a missing docker binary", async () => {
      const ex = new DockerExecutor({ container: "c", dockerPath: "/nonexistent/docker" });
      await expect(ex.exec("true")).rejects.toThrow(/could not run/);
      await expect(ex.readFile("x")).rejects.toThrow(/could not run/);
    });
  });

  describe("ensureMachine and removeMachine", () => {
    beforeEach(async () => {
      await rm(logFile, { force: true });
      await rm(stateFile, { force: true });
    });

    const options = () => ({
      name: "suup-bot-machine",
      image: "suup-sandbox:test",
      volume: "suup-bot-workspace",
      dockerPath,
    });

    it("creates the volume and a locked-down container when absent", async () => {
      expect(await ensureMachine(options())).toEqual({ created: true });
      const all = await calls();
      expect(all.map((c) => c.slice(0, 2).join(" "))).toEqual([
        "inspect --type",
        "volume create",
        "run --detach",
      ]);
      expect(all[1]).toEqual(["volume", "create", "suup-bot-workspace"]);
      const run = all[2] as string[];
      const flag = (name: string) => run[run.indexOf(name) + 1];
      expect(flag("--name")).toBe("suup-bot-machine");
      expect(flag("--user")).toBe("bot");
      expect(flag("--cap-drop")).toBe("ALL");
      expect(flag("--security-opt")).toBe("no-new-privileges");
      expect(flag("--memory")).toBe("2g");
      expect(flag("--memory-swap")).toBe("2g");
      expect(flag("--cpus")).toBe("2");
      expect(flag("--pids-limit")).toBe("512");
      expect(flag("--restart")).toBe("unless-stopped");
      expect(flag("--volume")).toBe("suup-bot-workspace:/workspace");
      expect(run).toContain("--init");
      expect(run.slice(-3)).toEqual(["suup-sandbox:test", "sleep", "infinity"]);
    });

    it("applies custom limits", async () => {
      await ensureMachine({ ...options(), memory: "512m", cpus: 0.5, pidsLimit: 64 });
      const run = (await calls()).find((c) => c[0] === "run") as string[];
      expect(run[run.indexOf("--memory") + 1]).toBe("512m");
      expect(run[run.indexOf("--cpus") + 1]).toBe("0.5");
      expect(run[run.indexOf("--pids-limit") + 1]).toBe("64");
    });

    it("is idempotent: a running container is left alone", async () => {
      await ensureMachine(options());
      await rm(logFile, { force: true });
      expect(await ensureMachine(options())).toEqual({ created: false });
      expect((await calls()).map((c) => c[0])).toEqual(["inspect"]);
    });

    it("starts a stopped container instead of creating another", async () => {
      await ensureMachine(options());
      const { writeFile } = await import("node:fs/promises");
      await writeFile(stateFile, JSON.stringify({ exists: true, running: false }));
      await rm(logFile, { force: true });
      expect(await ensureMachine(options())).toEqual({ created: false });
      expect((await calls()).map((c) => c[0])).toEqual(["inspect", "start"]);
    });

    it("rejects values that could be read as docker options", async () => {
      await expect(ensureMachine({ ...options(), name: "--privileged" })).rejects.toThrow(
        /invalid/,
      );
      await expect(ensureMachine({ ...options(), volume: "-v" })).rejects.toThrow(/invalid/);
      await expect(ensureMachine({ ...options(), image: "--rm" })).rejects.toThrow(/invalid/);
      await expect(ensureMachine({ ...options(), memory: "2g --privileged" })).rejects.toThrow(
        /invalid/,
      );
      await expect(ensureMachine({ ...options(), cpus: 0 })).rejects.toThrow(/invalid/);
      await expect(ensureMachine({ ...options(), pidsLimit: 1.5 })).rejects.toThrow(/invalid/);
      expect(await calls()).toEqual([]);
    });

    it("removeMachine removes the container, is idempotent, and can drop the volume", async () => {
      await ensureMachine(options());
      await removeMachine("suup-bot-machine", { dockerPath });
      await removeMachine("suup-bot-machine", { dockerPath }); // already gone: no error
      await removeMachine("suup-bot-machine", { dockerPath, volume: "suup-bot-workspace" });
      const all = await calls();
      expect(all.filter((c) => c[0] === "rm").length).toBe(3);
      expect(all.some((c) => c[0] === "volume" && c[1] === "rm")).toBe(true);
      await expect(removeMachine("--force", { dockerPath })).rejects.toThrow(/invalid/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Against a real Docker daemon: only with SUUP_DOCKER_TESTS=1 and SUUP_SANDBOX_IMAGE=<image>.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!REAL)("DockerExecutor with real Docker (SUUP_DOCKER_TESTS=1)", () => {
  const image = IMAGE ?? "";
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const name = `suup-test-${suffix}`;
  const volume = `suup-test-vol-${suffix}`;
  let base: DockerExecutor;
  let counter = 0;

  beforeAll(async () => {
    if (image === "")
      throw new Error("SUUP_DOCKER_TESTS=1 requires SUUP_SANDBOX_IMAGE (a built image tag)");
    await ensureMachine({ name, image, volume, memory: "512m", cpus: 1, pidsLimit: 256 });
    base = new DockerExecutor({ container: name, workspace: "/workspace", user: "bot" });
  }, 120_000);

  afterAll(async () => {
    await removeMachine(name, { volume });
  }, 60_000);

  it("runs as the non-root bot user with dropped capabilities", async () => {
    const who = await base.exec("id -un; id -u; grep CapEff /proc/self/status");
    const [user = "", uid = "", cap = ""] = who.stdout.trim().split("\n");
    expect(user).toBe("bot");
    expect(Number(uid)).not.toBe(0);
    expect(cap).toMatch(/0000000000000000$/);
    expect((await base.exec("cat /proc/self/status | grep NoNewPrivs")).stdout).toMatch(/1\s*$/);
  });

  it("has the tools the bots rely on", async () => {
    const r = await base.exec(
      "for t in bash curl git jq rg python3 unzip zip ps timeout realpath find pgrep; do command -v $t >/dev/null || echo missing:$t; done",
    );
    expect(r.stdout.trim()).toBe("");
  });

  it("ensureMachine is idempotent against a real daemon", async () => {
    expect(await ensureMachine({ name, image, volume })).toEqual({ created: false });
  });

  describeExecutorContract("DockerExecutor (real Docker)", async () => {
    const dir = `t-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
    await base.exec(`mkdir -p /workspace/${dir}`);
    const outsideDir = `/tmp/outside-${dir}`;
    await base.exec(`mkdir -p ${outsideDir}`);
    return {
      executor: new DockerExecutor({
        container: name,
        workspace: `/workspace/${dir}`,
        user: "bot",
      }),
      root: `/workspace/${dir}`,
      outsideDir,
      async dispose() {
        await base.exec(`rm -rf /workspace/${dir} ${outsideDir}`);
      },
    };
  });
});

describe.skipIf(REAL)("DockerExecutor with real Docker", () => {
  it.skip("skipped: set SUUP_DOCKER_TESTS=1 and SUUP_SANDBOX_IMAGE=<image> to run against a real daemon", () => {});
});
