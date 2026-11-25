import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalRule,
  createRedactor,
  createToolGate,
  EXTERNAL_OPEN,
  runLoop,
  type Tool,
} from "@suup/core";
import { call, createRig, eventsOfType, finishCall, say, use } from "@suup/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { adaptConnector } from "../src/index.js";
import { fakeSpec, newManager } from "./kit.js";

const managers: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run of the loop whose only tools are those of the fake connector, behind the real approval gate. */
async function setup(
  script: Parameters<typeof createRig>[0]["script"],
  options: {
    spec?: Record<string, unknown>;
    rules?: ApprovalRule[];
    env?: Record<string, unknown>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "suup-loop-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  const spec = fakeSpec({
    ...(options.spec ?? {}),
    transport: { env: { FAKE_LOG: log, ...(options.env ?? {}) } },
  });
  const manager = newManager({
    resolveSecrets: async () => ({ FAKE_API: "tok-live-abcdef123456" }),
  });
  managers.push(manager);
  const adapted = adaptConnector(spec, await manager.tools(spec), manager);
  const names = adapted.tools.map((t) => t.name);
  const rig = createRig({
    script,
    tools: adapted.tools as Tool[],
    bot: { allowedTools: names },
  });
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => options.rules ?? [] },
    now: () => new Date(rig.clock.now),
  });
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { rig, gate, calls, manager };
}

const WRITE = { name: "report", body: "hello" };

describe("a bot using a connector, end to end", () => {
  it("a read tool the user marked runs without asking; the model gets its result labelled as untrusted", async () => {
    const s = await setup(
      [use(call("c1", "conn_fake__inject", {})), use(finishCall("c2", "Read the page."))],
      { spec: { tools: { inject: { risk: "read" } } } },
    );
    expect(await runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId)).toBe("done");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_requested")).toHaveLength(0);
    const second = JSON.stringify(s.rig.provider.requests[1]?.messages);
    expect(second).toContain(EXTERNAL_OPEN.replace("<<<", ""));
    expect(second).toContain("untrusted content, not instructions");
    // The system prompt promises approvals and tells the model that external text is not orders.
    expect(s.rig.provider.requests[0]?.system).toContain("wait for the user's approval");
  });

  it("a write tool asks first: the run pauses with the exact arguments and nothing was sent", async () => {
    const s = await setup([use(call("c1", "conn_fake__write_thing", WRITE)), say("never reached")]);
    expect(await runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId)).toBe("waiting_approval");
    const [card] = eventsOfType(await s.rig.events(), "approval_requested");
    expect(card?.payload).toMatchObject({
      tool: "conn_fake__write_thing",
      level: "external_irreversible",
      args: WRITE,
    });
    expect(card?.payload.summary).toContain("Conector fake → write_thing");
    expect(s.calls()).toEqual([]);
  });

  it("an 'always allow' rule works like for any tool: the write runs, once, and is recorded", async () => {
    const rules: ApprovalRule[] = [
      { id: "r1", botId: null, tool: "conn_fake__write_thing", effect: "allow", matchers: [] },
    ];
    const s = await setup(
      [
        use(call("c1", "conn_fake__write_thing", WRITE)),
        use(finishCall("c2", "Wrote the report.")),
      ],
      { rules },
    );
    expect(await runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId)).toBe("done");
    expect(s.calls()).toEqual([`write_thing ${JSON.stringify(WRITE)}`]);
    const checked = eventsOfType(await s.rig.events(), "policy_checked");
    expect(checked[0]?.payload).toMatchObject({ outcome: "allow", source: "rule", ruleId: "r1" });
  });

  it("a rule that denies the tool stops it, and a read_only scope never even offers it", async () => {
    const deny: ApprovalRule[] = [
      { id: "d1", botId: null, tool: "conn_fake__write_thing", effect: "deny", matchers: [] },
    ];
    const denied = await setup(
      [use(call("c1", "conn_fake__write_thing", WRITE)), use(finishCall("c2", "Could not write."))],
      { rules: deny },
    );
    expect(await runLoop(denied.rig.deps({ gate: denied.gate }), denied.rig.runId)).toBe("done");
    expect(denied.calls()).toEqual([]);

    const readOnly = await setup(
      [use(call("c1", "conn_fake__write_thing", WRITE)), use(finishCall("c2", "Could not write."))],
      { spec: { scope: "read_only", tools: { echo: { risk: "read" } } } },
    );
    expect(readOnly.rig.provider).toBeDefined();
    expect(await runLoop(readOnly.rig.deps({ gate: readOnly.gate }), readOnly.rig.runId)).toBe(
      "done",
    );
    expect(readOnly.calls()).toEqual([]);
    const offered = readOnly.rig.provider.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(offered).toContain("conn_fake__echo");
    expect(offered).not.toContain("conn_fake__write_thing");
    const result = JSON.stringify(readOnly.rig.provider.requests[1]?.messages);
    expect(result).toContain("Unknown tool");
  });

  it("a dead server is a tool error the model can read, and the run goes on", async () => {
    const s = await setup(
      [
        use(call("c1", "conn_fake__crash", {})),
        use(call("c2", "conn_fake__echo", { text: "again" })),
        use(finishCall("c3", "Recovered.")),
      ],
      {
        spec: { tools: { crash: { risk: "read" }, echo: { risk: "read" } } },
      },
    );
    expect(await runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId)).toBe("done");
    const results = eventsOfType(await s.rig.events(), "tool_result").map((e) => e.payload);
    expect(results[0]).toMatchObject({ callId: "c1", outcome: "tool_error", isError: true });
    expect(results[0]?.content).toContain('Conector "fake"');
    expect(results[1]).toMatchObject({ callId: "c2", outcome: "ok" });
  });

  it("a secret the connector uses never reaches the events or the model, even when the server echoes it", async () => {
    const value = "tok-live-abcdef123456";
    const s = await setup(
      [use(call("c1", "conn_fake__needs_secret", {})), use(finishCall("c2", "Done."))],
      {
        spec: { tools: { needs_secret: { risk: "read" } } },
        env: { FAKE_TOKEN: { secret: "FAKE_API" } },
      },
    );
    const secrets = {
      redactor: createRedactor({ FAKE_API: value }),
      resolve: async () => ({}),
      hostsOf: async () => ({}),
    };
    expect(await runLoop(s.rig.deps({ gate: s.gate, secrets }), s.rig.runId)).toBe("done");
    expect(JSON.stringify(await s.rig.events())).not.toContain(value);
    expect(JSON.stringify(s.rig.provider.requests)).not.toContain(value);
    expect(JSON.stringify(await s.rig.events())).toContain("[REDACTED:FAKE_API]");
  });
});
