import { describe, expect, it } from "vitest";
import { call } from "./helpers.js";
import { localWorkspace } from "./local-helpers.js";

describe("shell (LocalExecutor)", () => {
  it("returns labelled exit code, stdout and stderr", async () => {
    const ex = await localWorkspace();
    const r = await call(ex, "shell", { command: "echo hello; echo oops >&2" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe("exit code: 0\n--- stdout ---\nhello\n--- stderr ---\noops");
  });

  it("marks empty streams", async () => {
    const r = await call(await localWorkspace(), "shell", { command: "true" });
    expect(r.output.content).toBe("exit code: 0\n--- stdout ---\n(empty)\n--- stderr ---\n(empty)");
  });

  it("reports a non-zero exit code without treating it as a tool failure", async () => {
    const r = await call(await localWorkspace(), "shell", { command: "echo partial; exit 7" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain("exit code: 7");
    expect(r.output.content).toContain("partial");
  });

  it("runs in cwd, and files persist between calls", async () => {
    const ex = await localWorkspace();
    await call(ex, "shell", { command: "mkdir -p proj && echo data > proj/f.txt" });
    const r = await call(ex, "shell", { command: 'cat f.txt && basename "$PWD"', cwd: "proj" });
    expect(r.output.content).toContain("data\nproj");
  });

  it("does not keep shell state between calls", async () => {
    const ex = await localWorkspace();
    await call(ex, "shell", { command: "mkdir sub && cd sub && export FOO=1" });
    const r = await call(ex, "shell", { command: 'echo "[$FOO]"; basename "$PWD"' });
    expect(r.output.content).toContain("[]");
    expect(r.output.content).not.toContain("sub");
  });

  it("kills a command that exceeds timeout_seconds, with its children, and says so", async () => {
    const ex = await localWorkspace();
    const started = Date.now();
    const r = await call(ex, "shell", {
      command: "sleep 300 & echo $! > child.pid; echo before; wait",
      timeout_seconds: 1,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("TIMED OUT after 1s");
    expect(r.output.content).toContain("before");
    const pid = (await ex.exec("cat child.pid")).stdout.trim();
    let state = "";
    for (let i = 0; i < 30 && state !== "gone" && state !== "Z"; i++) {
      state = (
        await ex.exec(`[ -r /proc/${pid}/stat ] && awk '{print $3}' /proc/${pid}/stat || echo gone`)
      ).stdout.trim();
      if (state !== "gone" && state !== "Z") await new Promise((r) => setTimeout(r, 100));
    }
    expect(["gone", "Z"]).toContain(state);
  });

  it("rejects timeouts above the maximum at validation", async () => {
    const r = await call(await localWorkspace(), "shell", {
      command: "true",
      timeout_seconds: 601,
    });
    expect(r.outcome).toBe("invalid_args");
  });

  it("reports a cwd that does not exist or escapes as a readable error", async () => {
    const ex = await localWorkspace();
    const missing = await call(ex, "shell", { command: "ls", cwd: "nope" });
    expect(missing.output.content).toContain("exit code: 1");
    expect(missing.output.content).toContain("working directory not found");
    const escaped = await call(ex, "shell", { command: "ls", cwd: "../.." });
    expect(escaped.outcome).toBe("tool_error");
    expect(escaped.output.content).toContain("outside the bot workspace");
  });

  it("stops when the run is aborted", async () => {
    const ex = await localWorkspace();
    const controller = new AbortController();
    const pending = call(ex, "shell", { command: "sleep 300" }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    const r = await pending;
    expect(r.outcome).toBe("aborted");
  });

  it("works together with the other file tools in one workspace", async () => {
    const ex = await localWorkspace();
    await call(ex, "write_file", { path: "script.sh", content: "echo from-script\n" });
    const r = await call(ex, "shell", { command: "sh script.sh" });
    expect(r.output.content).toContain("from-script");
    await call(ex, "edit_file", {
      path: "script.sh",
      old_string: "from-script",
      new_string: "edited",
    });
    expect((await call(ex, "shell", { command: "sh script.sh" })).output.content).toContain(
      "edited",
    );
    expect((await call(ex, "read_file", { path: "script.sh" })).output.content).toBe(
      "   1\techo edited",
    );
  });

  it("truncates huge output through the registry and saves the full text in the workspace", async () => {
    const ex = await localWorkspace();
    const r = await call(ex, "shell", { command: "seq 1 20000" });
    expect(r.truncated).toBe(true);
    expect(r.savedTo).toMatch(/^\.suup\/outputs\//);
    expect(await ex.readFile(r.savedTo as string)).toContain("20000");
  });
});
