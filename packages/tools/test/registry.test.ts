import { ToolRegistry } from "@suup/core";
import { describe, expect, it } from "vitest";
import { builtinTools, memoryTools, registerBuiltinTools } from "../src/index.js";
import { registry } from "./helpers.js";

describe("builtin tools", () => {
  it("registers exactly the expected names, once each", () => {
    expect(builtinTools.map((t) => t.name)).toEqual([
      "shell",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "search_files",
      "web_fetch",
      "web_search",
      "web_read",
    ]);
    const fresh = registerBuiltinTools(new ToolRegistry());
    expect(fresh.list().length).toBe(builtinTools.length + memoryTools.length);
    expect(fresh.list().map((t) => t.name)).toEqual([
      ...builtinTools.map((t) => t.name),
      ...memoryTools.map((t) => t.name),
    ]);
    expect(() => registerBuiltinTools(fresh)).toThrow(/already registered/);
  });

  it("keeps the memory tools in their own export, registered with the built-ins", () => {
    expect(memoryTools.map((t) => [t.name, t.risk])).toEqual([
      ["remember", "write_reversible"],
      ["recall", "read"],
      ["forget", "write_reversible"],
      ["search_conversations", "read"],
    ]);
  });

  it("assigns the intended risk levels", () => {
    const risks = Object.fromEntries(builtinTools.map((t) => [t.name, t.risk]));
    expect(risks).toEqual({
      // The default of a tool that classifies each call (see below): the safe side.
      shell: "external_irreversible",
      read_file: "read",
      write_file: "write_reversible",
      edit_file: "write_reversible",
      list_files: "read",
      search_files: "read",
      web_fetch: "read",
      web_search: "read",
      web_read: "read",
    });
  });

  it("shell is reversible only where it cannot reach the user's computer, and a secret raises it", () => {
    const isolated = { isolated: true } as never;
    const real = { isolated: false } as never;
    const classify = (executor: never, command: string) =>
      registry.assess("shell", { command }, { executor })?.level;
    expect(classify(isolated, "ls")).toBe("write_reversible");
    expect(classify(real, "ls")).toBe("external_irreversible");
    // No guessing from the command: even a plain `rm` or `curl -X POST` is judged by where it runs.
    expect(classify(isolated, "curl -X POST https://example.com -d x")).toBe("write_reversible");
    // A secret exists to prove who the user is to somebody else.
    expect(classify(isolated, "curl -H 'Authorization: {{secret:T}}' https://x.test")).toBe(
      "external_irreversible",
    );
    expect(
      registry.assess("web_fetch", { url: "https://x.test" }, { executor: isolated })?.level,
    ).toBe("read");
    expect(
      registry.assess(
        "web_fetch",
        { url: "https://x.test", headers: { Authorization: "Bearer {{secret:T}}" } },
        { executor: isolated },
      )?.level,
    ).toBe("external_irreversible");
  });

  it("declares which fields take secrets and whose output is external", () => {
    const info = Object.fromEntries(
      builtinTools.map((t) => [t.name, [t.secretFields ?? [], t.externalOutput === true]]),
    );
    expect(info.shell).toEqual([["command"], false]);
    expect(info.web_fetch).toEqual([["url", "headers.*"], true]);
    expect(info.write_file).toEqual([[], false]);
    // Search and read carry no secret and bring everything from outside.
    expect(info.web_search).toEqual([[], true]);
    expect(info.web_read).toEqual([[], true]);
  });

  it("does not include tools that belong elsewhere", () => {
    const names = builtinTools.map((t) => t.name);
    for (const absent of ["plan", "finish", "escalate"]) {
      expect(names).not.toContain(absent);
    }
  });

  it("gives the model a description and a documented object schema for every tool", () => {
    for (const spec of registry.specs()) {
      expect(spec.description.length, spec.name).toBeGreaterThan(80);
      const schema = spec.inputSchema as {
        type: string;
        properties: Record<string, { description?: string }>;
        required?: string[];
      };
      expect(schema.type).toBe("object");
      for (const [field, def] of Object.entries(schema.properties)) {
        expect(def.description, `${spec.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("rejects bad arguments through the registry with a usable message", async () => {
    const { MemoryExecutor } = await import("@suup/core/testing");
    const { call } = await import("./helpers.js");
    const r = await call(new MemoryExecutor(), "read_file", { path: "" });
    expect(r.outcome).toBe("invalid_args");
    const t = await call(new MemoryExecutor(), "shell", {
      command: "echo",
      timeout_seconds: 99999,
    });
    expect(t.outcome).toBe("invalid_args");
    expect(t.output.content).toContain("timeout_seconds");
  });
});
