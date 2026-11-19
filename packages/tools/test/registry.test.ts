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
      ["remember", "write"],
      ["recall", "read"],
      ["forget", "write"],
      ["search_conversations", "read"],
    ]);
  });

  it("assigns the intended risk levels", () => {
    const risks = Object.fromEntries(builtinTools.map((t) => [t.name, t.risk]));
    expect(risks).toEqual({
      shell: "write",
      read_file: "read",
      write_file: "write",
      edit_file: "write",
      list_files: "read",
      search_files: "read",
      web_fetch: "read",
    });
  });

  it("does not include tools that belong elsewhere", () => {
    const names = builtinTools.map((t) => t.name);
    for (const absent of ["web_search", "plan", "finish", "escalate"]) {
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
