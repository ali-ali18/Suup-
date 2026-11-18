import { type Executor, WorkspaceEscapeError } from "@suup/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface ContractFixture {
  executor: Executor;
  /** Absolute path of the workspace as the executor's machine sees it. */
  root: string;
  /** An existing, writable directory OUTSIDE the workspace, as the executor's machine sees it. */
  outsideDir: string;
  dispose(): Promise<void>;
}

export type ContractFactory = () => Promise<ContractFixture>;

/**
 * Behaviour every `Executor` must have. Run it against each implementation with a factory that
 * builds a fresh, empty workspace per call.
 */
export function describeExecutorContract(name: string, factory: ContractFactory): void {
  // Generous per-test limit: against real Docker every `exec` costs a process start.
  describe(`Executor contract: ${name}`, { timeout: 60_000 }, () => {
    const fixtures: ContractFixture[] = [];
    let fx: ContractFixture;
    let ex: Executor;

    const fresh = async (): Promise<ContractFixture> => {
      const created = await factory();
      fixtures.push(created);
      return created;
    };

    beforeAll(async () => {
      fx = await fresh();
      ex = fx.executor;
    }, 60_000);
    afterAll(async () => {
      await Promise.all(fixtures.map((f) => f.dispose()));
    });

    /** True once the process is gone (a zombie that was not reaped counts as gone). */
    async function isGone(pid: string): Promise<boolean> {
      for (let i = 0; i < 30; i++) {
        const r = await ex.exec(
          `if [ -r /proc/${pid}/stat ]; then awk '{print $3}' /proc/${pid}/stat; else echo gone; fi`,
        );
        const state = r.stdout.trim();
        if (state === "gone" || state === "Z") return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }

    describe("exec", () => {
      it("returns stdout, stderr and exit code 0", async () => {
        const r = await ex.exec("echo out; echo err >&2");
        expect(r).toEqual({ exitCode: 0, stdout: "out\n", stderr: "err\n", timedOut: false });
      });

      it("reports a non-zero exit code without rejecting", async () => {
        const r = await ex.exec("echo bye; exit 3");
        expect(r.exitCode).toBe(3);
        expect(r.stdout).toBe("bye\n");
        expect(r.timedOut).toBe(false);
      });

      it("reports a missing command as a non-zero exit", async () => {
        const r = await ex.exec("definitely-not-a-command-xyz");
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).not.toBe("");
      });

      it("handles hostile characters in the command as plain shell input", async () => {
        const r = await ex.exec(`printf '%s' 'it'"'"'s "quoted" $HOME \`x\` $(echo no)' | wc -c`);
        expect(r.exitCode).toBe(0);
        expect(Number(r.stdout.trim())).toBeGreaterThan(10);
      });

      it("does not give the command a usable stdin", async () => {
        const r = await ex.exec("cat", { timeoutMs: 10_000 });
        expect(r.timedOut).toBe(false);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("");
      });

      it("runs in the workspace root by default and in cwd when given", async () => {
        await ex.exec("mkdir -p sub/dir");
        const root = await ex.exec("pwd");
        expect(root.stdout.trim()).toBe(fx.root);
        const sub = await ex.exec("pwd", { cwd: "sub/dir" });
        expect(sub.stdout.trim()).toBe(`${fx.root}/sub/dir`);
      });

      it("returns a non-zero exit when cwd does not exist", async () => {
        const r = await ex.exec("echo hi", { cwd: "no/such/dir" });
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("working directory not found");
      });

      it("rejects a cwd outside the workspace", async () => {
        await expect(ex.exec("pwd", { cwd: ".." })).rejects.toBeInstanceOf(WorkspaceEscapeError);
        await expect(ex.exec("pwd", { cwd: "/" })).rejects.toBeInstanceOf(WorkspaceEscapeError);
      });

      it("rejects a cwd that is a symlink to outside", async () => {
        await ex.exec(`ln -sfn '${fx.outsideDir}' cwd-link`);
        await expect(ex.exec("pwd", { cwd: "cwd-link" })).rejects.toBeInstanceOf(
          WorkspaceEscapeError,
        );
      });

      it("passes opts.env to the command", async () => {
        const r = await ex.exec('printf "%s|%s" "$A_VAR" "$B_VAR"', {
          env: { A_VAR: "one", B_VAR: "two words; $(echo x)" },
        });
        expect(r.stdout).toBe("one|two words; $(echo x)");
      });

      it("does not leak the environment of the host process", async () => {
        process.env.SUUP_CONTRACT_SECRET = "top-secret";
        try {
          const r = await ex.exec(`printf "%s" "\${SUUP_CONTRACT_SECRET-unset}"`);
          expect(r.stdout).toBe("unset");
        } finally {
          delete process.env.SUUP_CONTRACT_SECRET;
        }
      });

      it("kills the command and its children on timeout", async () => {
        const started = Date.now();
        const r = await ex.exec("sleep 300 & echo $! > timeout-child.pid; wait", {
          timeoutMs: 700,
        });
        expect(r.timedOut).toBe(true);
        expect(r.exitCode).toBeNull();
        expect(Date.now() - started).toBeLessThan(15_000);
        const pid = (await ex.exec("cat timeout-child.pid")).stdout.trim();
        expect(pid).toMatch(/^\d+$/);
        expect(await isGone(pid)).toBe(true);
      });

      it("does not report a timeout for commands that exit with 124, 137 or 198 by themselves", async () => {
        for (const code of [124, 137, 198]) {
          const r = await ex.exec(`echo out; exit ${code}`, { timeoutMs: 30_000 });
          expect(r, `exit ${code}`).toEqual({
            exitCode: code,
            stdout: "out\n",
            stderr: "",
            timedOut: false,
          });
        }
      });

      it("does not report a timeout for a command that kills itself with SIGKILL", async () => {
        const r = await ex.exec("echo before; kill -9 $$", { timeoutMs: 30_000 });
        expect(r.timedOut).toBe(false);
        expect(r.stdout).toBe("before\n");
        expect([null, 137]).toContain(r.exitCode);
      });

      it("reports a timeout cleanly: no exit code, no private marker in stderr", async () => {
        const r = await ex.exec("echo oops >&2; sleep 300", { timeoutMs: 600 });
        expect(r.timedOut).toBe(true);
        expect(r.exitCode).toBeNull();
        expect(r.stderr).toBe("oops\n");
      });

      it("does not leave a watchdog running after a command that finishes in time", async () => {
        await ex.exec("echo quick", { timeoutMs: 60_000 });
        const r = await ex.exec("ps -eo args= | grep -c '[s]leep 60.000' || true");
        expect(Number(r.stdout.trim())).toBe(0);
      });

      it("keeps partial output of a command that timed out", async () => {
        const r = await ex.exec("echo started; sleep 300", { timeoutMs: 1500 });
        expect(r.timedOut).toBe(true);
        expect(r.stdout).toContain("started");
      });

      it("stops on abort and kills the children", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const pending = ex.exec("sleep 300 & echo $! > abort-child.pid; wait", {
          signal: controller.signal,
          timeoutMs: 120_000,
        });
        setTimeout(() => controller.abort(), 1200);
        const r = await pending;
        expect(r.exitCode).toBeNull();
        expect(r.timedOut).toBe(false);
        expect(Date.now() - started).toBeLessThan(20_000);
        const pid = (await ex.exec("cat abort-child.pid")).stdout.trim();
        expect(pid).toMatch(/^\d+$/);
        expect(await isGone(pid)).toBe(true);
      });

      it("resolves immediately when the signal is already aborted", async () => {
        const r = await ex.exec("echo should-not-run", { signal: AbortSignal.abort() });
        expect(r.exitCode).toBeNull();
        expect(r.stdout).toBe("");
      });

      it("caps captured output and still lets the command finish", async () => {
        const r = await ex.exec("head -c 3000000 /dev/zero | tr '\\0' a; echo done >&2", {
          timeoutMs: 60_000,
        });
        expect(r.timedOut).toBe(false);
        expect(r.stdout.length).toBeLessThan(2_000_000);
        expect(r.stdout.length).toBeGreaterThan(500_000);
        expect(r.stdout).toContain("output truncated");
        expect(r.stderr).toBe("done\n");
      });
    });

    describe("files", () => {
      it("round-trips UTF-8 text with awkward characters", async () => {
        const content = `línea 1 é 中文 \u{1F600}\n'single' "double" $(echo no) \`tick\` \\ back\r\n\n  trailing  `;
        await ex.writeFile("roundtrip.txt", content);
        expect(await ex.readFile("roundtrip.txt")).toBe(content);
      });

      it("round-trips empty content and content without a final newline", async () => {
        await ex.writeFile("empty.txt", "");
        expect(await ex.readFile("empty.txt")).toBe("");
        await ex.writeFile("nonl.txt", "abc");
        expect(await ex.readFile("nonl.txt")).toBe("abc");
      });

      it("creates missing parent directories and replaces existing content", async () => {
        await ex.writeFile("a/b/c/deep.txt", "one");
        await ex.writeFile("a/b/c/deep.txt", "two");
        expect(await ex.readFile("a/b/c/deep.txt")).toBe("two");
        expect((await ex.stat("a/b"))?.kind).toBe("dir");
      });

      it("accepts an absolute path inside the workspace", async () => {
        await ex.writeFile(`${fx.root}/abs.txt`, "abs");
        expect(await ex.readFile("abs.txt")).toBe("abs");
        expect(await ex.readFile(`${fx.root}/abs.txt`)).toBe("abs");
      });

      it("treats hostile file names as data, not as shell syntax", async () => {
        const name = "we ird $(touch pwned) `touch pwned2` ; 'q' \"dq\".txt";
        await ex.writeFile(name, "x");
        expect(await ex.readFile(name)).toBe("x");
        expect(await ex.stat("pwned")).toBeNull();
        expect(await ex.stat("pwned2")).toBeNull();
        const entries = await ex.listDir(".");
        expect(entries.map((e) => e.name)).toContain(name);
        await ex.writeFile("--leading-dash.txt", "d");
        expect(await ex.readFile("--leading-dash.txt")).toBe("d");
      });

      it("rejects reading a missing file and a directory", async () => {
        await expect(ex.readFile("missing.txt")).rejects.toThrow();
        await ex.exec("mkdir -p adir");
        await expect(ex.readFile("adir")).rejects.toThrow();
      });

      it("rejects writing onto a directory and under a regular file", async () => {
        await ex.exec("mkdir -p wdir; echo x > plainfile");
        await expect(ex.writeFile("wdir", "x")).rejects.toThrow();
        await expect(ex.writeFile("plainfile/child.txt", "x")).rejects.toThrow();
      });

      it("lists a directory with kinds, sorted by name", async () => {
        await ex.exec("mkdir -p ls/zdir ls/adir; echo 1 > ls/file-b; echo 2 > ls/file-a");
        expect(await ex.listDir("ls")).toEqual([
          { name: "adir", kind: "dir" },
          { name: "file-a", kind: "file" },
          { name: "file-b", kind: "file" },
          { name: "zdir", kind: "dir" },
        ]);
      });

      it("lists an empty directory and rejects a file or a missing directory", async () => {
        await ex.exec("mkdir -p emptydir; echo x > afile");
        expect(await ex.listDir("emptydir")).toEqual([]);
        await expect(ex.listDir("afile")).rejects.toThrow();
        await expect(ex.listDir("nope")).rejects.toThrow();
      });

      it("lists the workspace root", async () => {
        const names = (await ex.listDir(".")).map((e) => e.name);
        expect(names).toContain("roundtrip.txt");
      });

      it("stats files, directories and missing paths", async () => {
        await ex.writeFile("sized.txt", "héllo"); // 6 bytes in UTF-8
        expect(await ex.stat("sized.txt")).toEqual({ kind: "file", size: 6 });
        await ex.exec("mkdir -p statdir");
        expect(await ex.stat("statdir")).toEqual({ kind: "dir", size: 0 });
        expect(await ex.stat("nothing-here")).toBeNull();
        expect(await ex.stat(".")).toEqual({ kind: "dir", size: 0 });
      });

      it("sees files made by exec and exec sees files made by writeFile", async () => {
        await ex.exec("printf made-by-shell > shell.txt");
        expect(await ex.readFile("shell.txt")).toBe("made-by-shell");
        await ex.writeFile("api.txt", "made-by-api");
        expect((await ex.exec("cat api.txt")).stdout).toBe("made-by-api");
      });

      it("follows a symlink that stays inside the workspace", async () => {
        await ex.writeFile("real/target.txt", "inside");
        await ex.exec("ln -sfn real alias");
        expect(await ex.readFile("alias/target.txt")).toBe("inside");
        await ex.writeFile("alias/new.txt", "via-alias");
        expect(await ex.readFile("real/new.txt")).toBe("via-alias");
      });
    });

    describe("workspace escapes", () => {
      const escapes = [
        "..",
        "../x",
        "a/../../x",
        "/",
        "/etc/passwd",
        "/tmp/elsewhere",
        "bad\0name",
      ];

      for (const path of escapes) {
        it(`rejects ${JSON.stringify(path)} for every file operation`, async () => {
          await expect(ex.readFile(path)).rejects.toBeInstanceOf(WorkspaceEscapeError);
          await expect(ex.writeFile(path, "x")).rejects.toBeInstanceOf(WorkspaceEscapeError);
          await expect(ex.listDir(path)).rejects.toBeInstanceOf(WorkspaceEscapeError);
          await expect(ex.stat(path)).rejects.toBeInstanceOf(WorkspaceEscapeError);
        });
      }

      describe("through symlinks", () => {
        beforeAll(async () => {
          const out = fx.outsideDir;
          await ex.exec(
            [
              `printf 'outside-secret' > '${out}/secret.txt'`,
              `ln -sfn '${out}' link-dir`,
              `ln -sfn '${out}/secret.txt' link-file`,
              `ln -sfn '${out}/not-yet-created.txt' link-dangling`,
              `ln -sfn '${out}/missing-dir' link-dangling-dir`,
              "ln -sfn link-hop2 link-hop1",
              `ln -sfn '${out}' link-hop2`,
            ].join("\n"),
          );
        });

        it("refuses to read through a file symlink", async () => {
          await expect(ex.readFile("link-file")).rejects.toBeInstanceOf(WorkspaceEscapeError);
        });

        it("refuses to read through a directory symlink", async () => {
          await expect(ex.readFile("link-dir/secret.txt")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
        });

        it("refuses to follow a chain of links that ends outside", async () => {
          await expect(ex.readFile("link-hop1/secret.txt")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
        });

        it("refuses to list or stat through a directory symlink", async () => {
          await expect(ex.listDir("link-dir")).rejects.toBeInstanceOf(WorkspaceEscapeError);
          await expect(ex.stat("link-dir")).rejects.toBeInstanceOf(WorkspaceEscapeError);
          await expect(ex.stat("link-file")).rejects.toBeInstanceOf(WorkspaceEscapeError);
        });

        it("refuses to write through a directory symlink and writes nothing", async () => {
          await expect(ex.writeFile("link-dir/planted.txt", "x")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
          expect((await ex.exec(`test -e '${fx.outsideDir}/planted.txt'`)).exitCode).not.toBe(0);
        });

        it("refuses to overwrite an outside file through a file symlink", async () => {
          await expect(ex.writeFile("link-file", "overwritten")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
          expect((await ex.exec(`cat '${fx.outsideDir}/secret.txt'`)).stdout).toBe(
            "outside-secret",
          );
        });

        it("refuses to create an outside file through a dangling symlink", async () => {
          await expect(ex.writeFile("link-dangling", "x")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
          await expect(ex.writeFile("link-dangling-dir/x.txt", "x")).rejects.toBeInstanceOf(
            WorkspaceEscapeError,
          );
          expect(
            (await ex.exec(`test -e '${fx.outsideDir}/not-yet-created.txt'`)).exitCode,
          ).not.toBe(0);
          expect((await ex.exec(`test -e '${fx.outsideDir}/missing-dir'`)).exitCode).not.toBe(0);
        });
      });
    });
  });
}
