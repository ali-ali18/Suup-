import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createReplayGate, createToolGate } from "./approvals/index.js";
import { ToolRegistry } from "./registry.js";
import { classifyCall } from "./risk.js";
import { createRedactor, type SecretAccess, SecretUnavailableError } from "./secrets.js";
import { MemoryExecutor } from "./testing/memory-executor.js";
import { defineTool, type Tool, type ToolContext } from "./tool.js";

const VALUE = "tok_live_0123456789abcdef";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: "run-1",
    botId: "bot-1",
    executor: new MemoryExecutor(),
    signal: new AbortController().signal,
    now: () => new Date(0),
    ...overrides,
  };
}

/** `hosts`: where each secret may go (default: x.test, which the tests below call). */
function access(
  values: Record<string, string>,
  hosts: Record<string, string[]> = {},
): SecretAccess {
  const redactor = createRedactor();
  return {
    redactor,
    async hostsOf(names) {
      return Object.fromEntries(
        names.filter((name) => name in values).map((name) => [name, hosts[name] ?? ["x.test"]]),
      );
    },
    async resolve(names) {
      const out: Record<string, string> = {};
      for (const name of names) {
        const value = values[name];
        if (value === undefined) throw new SecretUnavailableError(name);
        redactor.add(name, value);
        out[name] = value;
      }
      return out;
    },
  };
}

describe("secrets in the registry", () => {
  const seen: unknown[] = [];
  const call = defineTool({
    name: "call_api",
    description: "Calls an API.",
    input: z.object({
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      note: z.string().optional(),
    }),
    risk: "read",
    secretFields: ["url", "headers.*"],
    secretDestination: "url",
    async execute(input) {
      seen.push(input);
      // A careless tool that echoes what it received.
      return { content: `called ${input.url} with ${JSON.stringify(input.headers ?? {})}` };
    },
  });
  const registry = new ToolRegistry().register(call);

  it("puts the value in at execution and scrubs it from what comes back", async () => {
    seen.length = 0;
    const secrets = access({ API_TOKEN: VALUE });
    const result = await registry.invoke(
      "call_api",
      {
        url: "https://x.test/?k={{secret:API_TOKEN}}",
        headers: { Authorization: "Bearer {{secret:API_TOKEN}}" },
      },
      ctx(),
      { secrets },
    );
    expect(result.outcome).toBe("ok");
    expect(JSON.stringify(seen)).toContain(VALUE); // the tool got the real value
    expect(result.output.content).not.toContain(VALUE); // the model does not
    expect(result.output.content).toContain("[REDACTED:API_TOKEN]");
  });

  it("refuses a placeholder in a field the tool did not declare, without running it", async () => {
    seen.length = 0;
    const result = await registry.invoke(
      "call_api",
      { url: "https://x.test", note: "{{secret:API_TOKEN}}" },
      ctx(),
      { secrets: access({ API_TOKEN: VALUE }) },
    );
    expect(result.outcome).toBe("invalid_args");
    expect(result.output.content).toContain('"note"');
    expect(result.output.content).not.toContain(VALUE);
    expect(seen).toHaveLength(0);
  });

  it("a tool that declares no secret field accepts no placeholder at all", async () => {
    const plain = new ToolRegistry().register(
      defineTool({
        name: "plain",
        description: "d",
        input: z.object({ text: z.string() }),
        risk: "read",
        execute: async ({ text }) => ({ content: text }),
      }),
    );
    const result = await plain.invoke("plain", { text: "{{secret:X}}" }, ctx(), {
      secrets: access({ X: VALUE }),
    });
    expect(result.outcome).toBe("invalid_args");
    expect(result.output.content).toContain("accepts none");
  });

  it("says plainly when the secret is not available, and when there is no vault", async () => {
    seen.length = 0;
    const missing = await registry.invoke(
      "call_api",
      { url: "https://x.test/{{secret:NOPE}}" },
      ctx(),
      {
        secrets: access({}),
      },
    );
    expect(missing.outcome).toBe("tool_error");
    expect(missing.output.content).toContain("secret NOPE is not available");
    const none = await registry.invoke(
      "call_api",
      { url: "https://x.test/{{secret:NOPE}}" },
      ctx(),
    );
    expect(none.outcome).toBe("tool_error");
    expect(none.output.content).toContain("no vault");
    expect(seen).toHaveLength(0);
  });

  it("a vault failure never leaks into the message", async () => {
    const broken: SecretAccess = {
      redactor: createRedactor({ OTHER: VALUE }),
      hostsOf: async () => ({ A: ["x.test"] }),
      resolve: async () => {
        throw new Error(`cannot decrypt, key was ${VALUE}`);
      },
    };
    const result = await registry.invoke(
      "call_api",
      { url: "https://x.test/{{secret:A}}" },
      ctx(),
      {
        secrets: broken,
      },
    );
    expect(result.outcome).toBe("crashed");
    expect(result.output.content).not.toContain(VALUE);
  });

  describe("a secret goes only where the user declared", () => {
    const run = (
      url: string,
      hosts: Record<string, string[]>,
      extra: Record<string, string> = {},
    ) =>
      registry.invoke("call_api", { url, headers: extra }, ctx(), {
        secrets: access({ API_TOKEN: VALUE }, hosts),
      });

    it("runs for a declared host, comparing the normalized name exactly", async () => {
      seen.length = 0;
      const ok = await run("https://API.Exemplo.com./v1?k={{secret:API_TOKEN}}", {
        API_TOKEN: ["api.exemplo.com"],
      });
      expect(ok.outcome).toBe("ok");
      expect(seen).toHaveLength(1);
    });

    it("refuses another host without resolving the value, naming both hosts", async () => {
      seen.length = 0;
      let resolved = false;
      const secrets = access({ API_TOKEN: VALUE }, { API_TOKEN: ["api.exemplo.com"] });
      const original = secrets.resolve;
      secrets.resolve = async (names) => {
        resolved = true;
        return original(names);
      };
      const out = await registry.invoke(
        "call_api",
        { url: "https://outro.exemplo.com/x?k={{secret:API_TOKEN}}" },
        ctx(),
        { secrets, beforeExecute: async () => ({ allow: true }) },
      );
      expect(out.outcome).toBe("tool_error");
      expect(out.output.content).toContain("outro.exemplo.com");
      expect(out.output.content).toContain("api.exemplo.com");
      expect(out.output.content).toContain("Do not try another secret name");
      expect(out.output.content).not.toContain(VALUE);
      expect(resolved).toBe(false);
      expect(seen).toHaveLength(0);
    });

    it("does not take a look-alike for the declared host", async () => {
      for (const url of [
        "https://api.exemplo.com.atacante.test/?k={{secret:API_TOKEN}}",
        "https://api.exemplo.com@atacante.test/?k={{secret:API_TOKEN}}",
        "https://atacante.test/api.exemplo.com?k={{secret:API_TOKEN}}",
        "https://sub.api.exemplo.com/?k={{secret:API_TOKEN}}",
      ]) {
        const out = await run(url, { API_TOKEN: ["api.exemplo.com"] });
        expect(out.outcome, url).toBe("tool_error");
      }
    });

    it("refuses a secret with no hosts declared (blocked)", async () => {
      seen.length = 0;
      const out = await run("https://api.exemplo.com/?k={{secret:API_TOKEN}}", { API_TOKEN: [] });
      expect(out.outcome).toBe("tool_error");
      expect(out.output.content).toContain("API_TOKEN has no addresses declared");
      expect(seen).toHaveLength(0);
    });

    it("checks every secret of the call, and a destination it cannot read", async () => {
      const secrets = access(
        { A_KEY: VALUE, B_KEY: "another-secret-value" },
        {
          A_KEY: ["api.exemplo.com"],
          B_KEY: ["outro.exemplo.com"],
        },
      );
      const both = await registry.invoke(
        "call_api",
        { url: "https://api.exemplo.com/?a={{secret:A_KEY}}&b={{secret:B_KEY}}" },
        ctx(),
        { secrets },
      );
      expect(both.outcome).toBe("tool_error");
      expect(both.output.content).toContain("B_KEY");
      const hidden = await run("https://{{secret:API_TOKEN}}/x", {
        API_TOKEN: ["api.exemplo.com"],
      });
      expect(hidden.outcome).toBe("tool_error");
      expect(hidden.output.content).toContain("plain http(s) address");
    });

    it("refuses any secret in a tool that declares no destination (the shell)", async () => {
      const shell = new ToolRegistry().register(
        defineTool({
          name: "shell_like",
          description: "d",
          input: z.object({ command: z.string() }),
          risk: "external_irreversible",
          secretFields: ["command"],
          execute: async () => ({ content: "ran" }),
        }),
      );
      const out = await shell.invoke(
        "shell_like",
        { command: "curl -H 'X: {{secret:API_TOKEN}}' https://api.exemplo.com" },
        ctx(),
        { secrets: access({ API_TOKEN: VALUE }, { API_TOKEN: ["api.exemplo.com"] }) },
      );
      expect(out.outcome).toBe("tool_error");
      expect(out.output.content).toContain("does not take secrets");
      expect(out.output.content).not.toContain(VALUE);
    });

    it("hands the allowed hosts (their intersection) to the tool, for redirects", async () => {
      let seenHosts: readonly string[] | undefined;
      const probe = new ToolRegistry().register(
        defineTool({
          name: "probe",
          description: "d",
          input: z.object({ url: z.string() }),
          risk: "read",
          secretFields: ["url"],
          secretDestination: "url",
          execute: async (_input, c) => {
            seenHosts = c.secretHosts;
            return { content: "ok" };
          },
        }),
      );
      const secrets = access(
        { A_KEY: VALUE, B_KEY: "another-secret-value" },
        {
          A_KEY: ["a.test", "b.test"],
          B_KEY: ["b.test", "c.test"],
        },
      );
      await probe.invoke(
        "probe",
        { url: "https://b.test/?a={{secret:A_KEY}}&b={{secret:B_KEY}}" },
        ctx(),
        { secrets },
      );
      expect(seenHosts).toEqual(["b.test"]);
    });

    it("tells the card where the secret would go", () => {
      const assessed = registry.assess(
        "call_api",
        { url: "https://api.exemplo.com/?k={{secret:API_TOKEN}}" },
        { executor: new MemoryExecutor() },
      );
      expect(assessed?.secretHost).toBe("api.exemplo.com");
    });
  });

  it("scrubs errors and the saved copy of a long output too", async () => {
    const files = new MemoryExecutor();
    const leaky = new ToolRegistry().register(
      defineTool({
        name: "leaky",
        description: "d",
        input: z.object({}),
        risk: "read",
        execute: async () => ({ content: `${"x".repeat(200)} ${VALUE} ${"y".repeat(200)}` }),
      }),
    );
    const secrets = {
      redactor: createRedactor({ T: VALUE }),
      resolve: async () => ({}),
      hostsOf: async () => ({}),
    };
    const result = await leaky.invoke("leaky", {}, ctx({ executor: files }), {
      secrets,
      maxOutputChars: 100,
      callId: "c1",
    });
    expect(result.truncated).toBe(true);
    expect(result.output.content).not.toContain(VALUE);
    const saved = await files.readFile(result.savedTo as string);
    expect(saved).not.toContain(VALUE);
    expect(saved).toContain("[REDACTED:T]");

    const crashing = new ToolRegistry().register(
      defineTool({
        name: "crash",
        description: "d",
        input: z.object({}),
        risk: "read",
        execute: async () => {
          throw new Error(`failed with ${VALUE}`);
        },
      }),
    );
    const crashed = await crashing.invoke("crash", {}, ctx(), { secrets });
    expect(crashed.outcome).toBe("crashed");
    expect(crashed.output.content).not.toContain(VALUE);
  });
});

describe("untrusted output", () => {
  it("is wrapped when the tool declares external output, whatever the result says", async () => {
    const registry = new ToolRegistry().register(
      defineTool({
        name: "fetcher",
        description: "d",
        input: z.object({}),
        risk: "read",
        externalOutput: true,
        execute: async () => ({ content: "page text" }),
      }),
    );
    const result = await registry.invoke("fetcher", {}, ctx());
    expect(result.output.untrusted).toBe(true);
    expect(result.output.content).toContain("<<<EXTERNAL_DATA");
    expect(result.output.content).toContain("page text");
  });

  it("is wrapped when one result says so, and not otherwise", async () => {
    const registry = new ToolRegistry().register(
      defineTool({
        name: "mixed",
        description: "d",
        input: z.object({ outside: z.boolean() }),
        risk: "read",
        execute: async ({ outside }) => ({ content: "text", untrusted: outside }),
      }),
    );
    expect((await registry.invoke("mixed", { outside: true }, ctx())).output.content).toContain(
      "EXTERNAL_DATA",
    );
    expect((await registry.invoke("mixed", { outside: false }, ctx())).output.content).toBe("text");
  });
});

describe("labelling by configuration", () => {
  it("a tool the user lists is labelled even if it does not declare external output", async () => {
    const make = (options: ConstructorParameters<typeof ToolRegistry>[0]) =>
      new ToolRegistry(options).register(
        defineTool({
          name: "shell_like",
          description: "d",
          input: z.object({}),
          risk: "read",
          execute: async () => ({ content: "output" }),
        }),
      );
    expect((await make({}).invoke("shell_like", {}, ctx())).output.content).toBe("output");
    const labelled = await make({ externalOutputTools: ["shell_like"] }).invoke(
      "shell_like",
      {},
      ctx(),
    );
    expect(labelled.output.untrusted).toBe(true);
    expect(labelled.output.content).toContain("<<<EXTERNAL_DATA");
  });
});

describe("assess and classification", () => {
  const executor = new MemoryExecutor();
  it("a declared outbound message is reported, is never a read, and nothing is inferred from names", () => {
    const declared = registry.assess("mailer", { to: "a@x.com" }, { executor });
    expect(declared?.outbound).toEqual({ kind: "message", recipientFields: ["to"] });
    expect(declared?.level).toBe("external_irreversible");
    const lookalike = registry.assess("send_mail_lookalike", { to: "a@x.com" }, { executor });
    expect(lookalike?.outbound).toBeUndefined();
    expect(lookalike?.level).toBe("read");
  });

  const tools: Tool[] = [
    defineTool({
      name: "plain",
      description: "d",
      input: z.object({ x: z.string() }),
      risk: "write_reversible",
      describe: ({ x }) => `Do ${x}`,
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      name: "mailer",
      description: "Sends an e-mail.",
      input: z.object({ to: z.string() }),
      risk: "read",
      outbound: { kind: "message", recipientFields: ["to"] },
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      // looks like a mailer by name and text, but declares nothing
      name: "send_mail_lookalike",
      description: "Sends an e-mail to somebody.",
      input: z.object({ to: z.string() }),
      risk: "read",
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      name: "dynamic",
      description: "d",
      input: z.object({ go: z.boolean() }),
      risk: "external_irreversible",
      classify: ({ go }, env) =>
        go && env.executor.isolated !== false ? "read" : "external_irreversible",
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      name: "throws",
      description: "d",
      input: z.object({}),
      risk: "read",
      classify: () => {
        throw new Error("bug");
      },
      execute: async () => ({ content: "" }),
    }),
    defineTool({
      name: "secretive",
      description: "d",
      input: z.object({ k: z.string() }),
      risk: "read",
      secretFields: ["k"],
      execute: async () => ({ content: "" }),
    }),
  ];
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);

  it("gives the level, the card line and the secrets of a valid call", () => {
    expect(registry.assess("plain", { x: "a" }, { executor })).toEqual({
      level: "write_reversible",
      args: { x: "a" },
      summary: "Do a",
      toolDescription: "d",
      secrets: [],
    });
    const used = registry.assess("secretive", { k: "{{secret:T}}" }, { executor });
    // A call that carries a secret is at least external: it exists to prove who the user is.
    expect(used).toMatchObject({ level: "external_irreversible", secrets: ["T"] });
    expect(used?.summary).toContain("secretive");
    expect(used?.summary).toContain("{{secret:T}}");
  });

  it("classifies by argument, and a classifier that fails is the safe side", () => {
    expect(registry.assess("dynamic", { go: true }, { executor })?.level).toBe("read");
    expect(registry.assess("dynamic", { go: false }, { executor })?.level).toBe(
      "external_irreversible",
    );
    expect(registry.assess("throws", {}, { executor })?.level).toBe("external_irreversible");
    const undeclared = {
      name: "u",
      description: "d",
      input: z.object({}),
      execute: async () => ({ content: "" }),
    };
    expect(classifyCall(undeclared as unknown as Tool, {}, { executor })).toBe(
      "external_irreversible",
    );
  });

  it("has nothing to say about an unknown tool, a forbidden one or bad arguments", () => {
    expect(registry.assess("nope", {}, { executor })).toBeUndefined();
    expect(registry.assess("plain", { x: 1 }, { executor })).toBeUndefined();
    expect(
      registry.assess("plain", { x: "a" }, { executor, allowed: ["dynamic"] }),
    ).toBeUndefined();
  });

  it("the gate applies a level override and expiry", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const gate = createToolGate({
      tools: registry,
      rules: { rulesFor: async () => [] },
      levelOverrides: { plain: "external_irreversible" },
      expireAfterMs: 60_000,
      now: () => now,
    });
    const verdict = await gate.check({
      runId: "r",
      callId: "c",
      botId: "b",
      name: "plain",
      args: { x: "a" },
      executor,
    });
    expect(verdict).toMatchObject({
      outcome: "ask",
      level: "external_irreversible",
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(
      await gate.check({ runId: "r", callId: "c", botId: "b", name: "nope", args: {}, executor }),
    ).toBeNull();
  });

  it("the gate treats a reviewer that fails as sensitive", async () => {
    const gate = createToolGate({
      tools: registry,
      rules: { rulesFor: async () => [] },
      reviewer: {
        review: async () => {
          throw new Error("down");
        },
      },
      now: () => new Date(0),
    });
    const verdict = await gate.check({
      runId: "r",
      callId: "c",
      botId: "b",
      name: "plain",
      args: { x: "a" },
      executor,
    });
    expect(verdict).toMatchObject({ outcome: "ask", source: "reviewer" });
  });

  it("the replay gate serves only what the recording decided", async () => {
    const gate = createReplayGate([
      {
        type: "policy_checked",
        payload: {
          callId: "a",
          tool: "t",
          level: "write_reversible",
          outcome: "allow",
          source: "default",
        },
      },
      {
        type: "approval_requested",
        payload: {
          approvalId: "id",
          callId: "b",
          tool: "t",
          args: { y: 1 },
          level: "external_irreversible",
          summary: "s",
          secrets: [],
          source: "default",
        },
      },
    ]);
    const base = { runId: "r", botId: "b", name: "t", args: {}, executor };
    expect(await gate.check({ ...base, callId: "a" })).toMatchObject({ outcome: "allow" });
    expect(await gate.check({ ...base, callId: "b" })).toMatchObject({
      outcome: "ask",
      approvalId: "id",
      args: { y: 1 },
    });
    expect(await gate.check({ ...base, callId: "z" })).toBeNull();
  });
});
