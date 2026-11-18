import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceEscapeError } from "@suup/core";
import { afterAll, describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/index.js";
import { describeExecutorContract } from "./executor-contract.js";

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suup-local-"));
  temps.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describeExecutorContract("LocalExecutor", async () => {
  const base = await tempDir();
  const root = join(base, "workspace");
  const outsideDir = join(base, "outside");
  await mkdir(outsideDir);
  return {
    executor: new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true }),
    root,
    outsideDir,
    async dispose() {},
  };
});

describe("LocalExecutor specifics", () => {
  it("refuses to be built without the isolation acknowledgement", () => {
    expect(() => new LocalExecutor({ root: "/tmp/x" } as never)).toThrow(/NO isolation/);
    expect(
      () => new LocalExecutor({ root: "/tmp/x", iUnderstandThisIsNotIsolated: false } as never),
    ).toThrow(/NO isolation/);
  });

  it("creates the root directory when missing", async () => {
    const base = await tempDir();
    const root = join(base, "a", "b", "workspace");
    const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true });
    expect(await ex.stat(".")).toEqual({ kind: "dir", size: 0 });
  });

  it("starts commands with a minimal clean environment", async () => {
    const root = await tempDir();
    process.env.SUUP_LOCAL_SECRET = "s3cret";
    try {
      const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true });
      const r = await ex.exec("env | sort");
      const names = r.stdout
        .split("\n")
        .map((line) => line.split("=")[0])
        .filter(
          (name) => name && name !== "PWD" && name !== "_" && name !== "OLDPWD" && name !== "SHLVL",
        );
      expect(names.sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
      expect(r.stdout).not.toContain("s3cret");
      expect((await ex.exec("echo $HOME")).stdout.trim()).toBe(ex.root);
    } finally {
      delete process.env.SUUP_LOCAL_SECRET;
    }
  });

  it("lets opts.env override the defaults", async () => {
    const root = await tempDir();
    const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true });
    const r = await ex.exec("echo $LANG", { env: { LANG: "pt_BR.UTF-8" } });
    expect(r.stdout.trim()).toBe("pt_BR.UTF-8");
  });

  it("honors a custom output cap and keeps the head of the output", async () => {
    const root = await tempDir();
    const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true, maxOutputBytes: 100 });
    const r = await ex.exec("printf 'abcdefghij%.0s' $(seq 1 1000)");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith("abcdefghij".repeat(10))).toBe(true);
    expect(r.stdout).toContain("output truncated: more than 100 bytes");
    expect(r.stdout.length).toBeLessThan(200);
  });

  it("does not wait for a background process that keeps the pipes open", async () => {
    const root = await tempDir();
    const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true });
    const started = Date.now();
    const r = await ex.exec("(sleep 5 &) ; echo done");
    expect(r.stdout).toContain("done");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects reading a file over the size limit", async () => {
    const root = await tempDir();
    const ex = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true, maxFileBytes: 10 });
    await writeFile(join(root, "big.txt"), "x".repeat(11));
    await expect(ex.readFile("big.txt")).rejects.toThrow(/too large/);
  });

  it("checks symlinks even when the root itself is reached through a link", async () => {
    const base = await tempDir();
    await mkdir(join(base, "real-root"));
    await symlink(join(base, "real-root"), join(base, "root-link"));
    await mkdir(join(base, "elsewhere"));
    await writeFile(join(base, "elsewhere", "f.txt"), "nope");
    await symlink(join(base, "elsewhere"), join(base, "real-root", "out"));
    const ex = new LocalExecutor({
      root: join(base, "root-link"),
      iUnderstandThisIsNotIsolated: true,
    });
    await ex.writeFile("ok.txt", "fine");
    expect(await readFile(join(base, "real-root", "ok.txt"), "utf8")).toBe("fine");
    await expect(ex.readFile("out/f.txt")).rejects.toBeInstanceOf(WorkspaceEscapeError);
  });
});
