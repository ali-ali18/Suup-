import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolGate } from "../approvals/index.js";
import { replayRun } from "../replay.js";
import {
  CrashingStore,
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  finishCall,
  planCall,
  type Rig,
  SimulatedCrash,
  testTools,
  use,
} from "../testing/index.js";
import { defineTool, type Tool } from "../tool.js";
import { runLoop } from "./loop.js";
import type { RunStatus, StoredEvent } from "./store.js";
import {
  DEFAULT_TOOL_SEARCH,
  firstSentence,
  planToolSearch,
  searchCatalog,
  type ToolSearchCandidate,
  type ToolSearchSetup,
  wordsOf,
} from "./tool-search.js";

// ---------------------------------------------------------------------------------------------
// A bot with 14 connector tools (two connectors) and the built-in test tools.

const sent: string[] = [];

function connectorTools(): { tools: Tool[]; candidates: ToolSearchCandidate[] } {
  const tools: Tool[] = [];
  const candidates: ToolSearchCandidate[] = [];
  const add = (
    name: string,
    group: string,
    summary: string,
    risk: "read" | "external_irreversible",
  ) => {
    tools.push(
      defineTool({
        name,
        description: `Tool "${name}" of the external connector "${group}". Description given by the server: ${summary}`,
        input: z.object({ query: z.string(), limit: z.number().int().optional() }),
        risk,
        describe: ({ query }) => `Conector ${group} → ${name} ${query}`,
        externalOutput: true,
        execute: async ({ query }) => {
          sent.push(`${name}:${query}`);
          return { content: `${name} ok for ${query}` };
        },
      }),
    );
    candidates.push({ name, group, summary });
  };
  add("conn_erp__search_orders", "erp", "Search sales orders by customer. Returns ids.", "read");
  add("conn_erp__cancel_order", "erp", "Cancel a sales order for good.", "external_irreversible");
  add("conn_crm__find_contact", "crm", "Find a contact by name or e-mail.", "read");
  for (let i = 0; i < 11; i++) {
    add(`conn_erp__report_${i}`, "erp", `Generate monthly report number ${i}.`, "read");
  }
  return { tools, candidates };
}

const CONNECTOR_NAMES = connectorTools().candidates.map((c) => c.name);

type Mechanism = "meta" | "hosted" | "client" | "direct";

interface Setup {
  rig: Rig;
  script: Parameters<typeof createRig>[0]["script"];
  deps(extra?: Partial<Parameters<Rig["deps"]>[0]>): ReturnType<Rig["deps"]>;
}

function setup(
  mechanism: Mechanism,
  script: Parameters<typeof createRig>[0]["script"],
  options: { candidates?: ToolSearchCandidate[]; tools?: Tool[] } = {},
): Setup {
  sent.length = 0;
  const made = connectorTools();
  const candidates = options.candidates ?? made.candidates;
  const rig = createRig({
    script,
    tools: [...testTools(), ...(options.tools ?? made.tools)],
    bot: { allowedTools: ["echo", "write_note", ...CONNECTOR_NAMES] },
  });
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => [] },
    now: () => new Date(rig.clock.now),
  });
  const native = mechanism === "hosted" ? "bm25" : mechanism === "client" ? "client" : undefined;
  const toolSearch: ToolSearchSetup = {
    settings:
      mechanism === "direct"
        ? { ...DEFAULT_TOOL_SEARCH, minTools: 1000, minDefinitionTokens: 10 ** 9 }
        : DEFAULT_TOOL_SEARCH,
    candidates,
    native,
  };
  const provider = (steps: typeof script) =>
    new FakeProvider(steps, {
      capabilities: native === undefined ? {} : { toolSearch: ["bm25", "regex", "client"] },
    });
  return {
    rig,
    script,
    deps: (extra = {}) => rig.deps({ provider: provider(script), gate, toolSearch, ...extra }),
  };
}

const catalogOf = (events: readonly StoredEvent[]) => eventsOfType(events, "tool_catalog")[0];
const toolNames = (req: { tools: { name: string }[] }) => req.tools.map((t) => t.name);

describe("the decision (planToolSearch)", () => {
  const specsOf = (n: number, descriptionChars = 10) => {
    const candidates: ToolSearchCandidate[] = [];
    const specs = new Map();
    for (let i = 0; i < n; i++) {
      const name = `conn_a__t${i}`;
      candidates.push({ name, group: "a", summary: "Does a thing." });
      specs.set(name, {
        name,
        description: "d".repeat(descriptionChars),
        inputSchema: { type: "object" },
      });
    }
    return { candidates, specs };
  };

  it("loads directly below BOTH limits: fewer than 10 tools and under 10k tokens", () => {
    const { candidates, specs } = specsOf(9);
    const catalog = planToolSearch(
      { settings: DEFAULT_TOOL_SEARCH, candidates, native: "bm25" },
      specs,
      { toolSearch: ["bm25"] },
    );
    expect(catalog).toMatchObject({ mode: "direct", connectorTools: 9, deferred: [] });
  });

  it("defers at 10 tools, or when the definitions reach 10k estimated tokens", () => {
    const ten = specsOf(10);
    expect(
      planToolSearch({ settings: DEFAULT_TOOL_SEARCH, candidates: ten.candidates }, ten.specs, {})
        .mode,
    ).toBe("meta");
    // 3 tools of 14 000 characters = 3 x 3 500 tokens + a little: over 10k.
    const big = specsOf(3, 14_000);
    const catalog = planToolSearch(
      { settings: DEFAULT_TOOL_SEARCH, candidates: big.candidates },
      big.specs,
      {},
    );
    expect(catalog.mode).toBe("meta");
    expect(catalog.definitionTokens).toBeGreaterThanOrEqual(10_000);
  });

  it("uses a native variant only when the model declares it AND the adapter implements it", () => {
    const { candidates, specs } = specsOf(12);
    const plan = (
      native: "bm25" | "client" | undefined,
      supported: readonly ("bm25" | "regex" | "client")[],
    ) =>
      planToolSearch({ settings: DEFAULT_TOOL_SEARCH, candidates, native }, specs, {
        toolSearch: supported,
      });
    expect(plan("bm25", ["bm25"]).mode).toBe("hosted");
    expect(plan("bm25", ["bm25"]).variant).toBe("bm25");
    expect(plan("client", ["client"]).mode).toBe("client");
    expect(plan("bm25", []).mode).toBe("meta"); // the adapter cannot
    expect(plan(undefined, ["bm25"]).mode).toBe("meta"); // the model did not declare it
    expect(plan("bm25", ["bm25"]).deferred.every((d) => d.spec.deferLoading === true)).toBe(true);
    expect(plan(undefined, []).deferred.every((d) => d.spec.deferLoading === undefined)).toBe(true);
  });

  it("builds a one-line-per-tool index, or one line per connector when it is large", () => {
    const { candidates, specs } = specsOf(12);
    const small = planToolSearch({ settings: DEFAULT_TOOL_SEARCH, candidates }, specs, {});
    expect(small.index).toContain("- conn_a__t0: Does a thing.");
    expect(small.index).toContain("- conn_a__t11: Does a thing.");
    const large = planToolSearch(
      { settings: { ...DEFAULT_TOOL_SEARCH, maxIndexChars: 300 }, candidates },
      specs,
      {},
    );
    expect(large.index).toContain("- a: 12 tool(s)");
    expect(large.index).not.toContain("conn_a__t0");
  });
});

describe("words, first sentence and ranking (no regular expressions)", () => {
  it("splits words by character class and lowercases", () => {
    expect(wordsOf("Search_Orders: by-customer (v2)!")).toEqual([
      "search",
      "orders",
      "by",
      "customer",
      "v2",
    ]);
    expect(wordsOf("Pedidos de venda — são paulo")).toEqual([
      "pedidos",
      "de",
      "venda",
      "são",
      "paulo",
    ]);
    expect(wordsOf("   ")).toEqual([]);
  });

  it("cuts the first sentence by punctuation followed by a space, a line break, or length", () => {
    expect(firstSentence("Search orders. Returns ids.")).toBe("Search orders.");
    expect(firstSentence("Version 1.5 of the thing is fine. Next")).toBe(
      "Version 1.5 of the thing is fine.",
    );
    expect(firstSentence("First line\nsecond line")).toBe("First line");
    expect(firstSentence("x".repeat(300), 20)).toHaveLength(20);
    expect(firstSentence("")).toBe("");
  });

  const deferred = connectorTools().candidates.map((c) => ({
    ...c,
    spec: {
      name: c.name,
      description: c.summary,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  }));

  it("ranks by distinct words in common, ties in catalog order, and filters a connector exactly", () => {
    const orders = searchCatalog(deferred, { words: "sales orders customer" });
    expect(orders.matches.map((m) => m.name).slice(0, 2)).toEqual([
      "conn_erp__search_orders",
      "conn_erp__cancel_order",
    ]);
    // "order" is not "orders": exact words, no stemming.
    expect(searchCatalog(deferred, { words: "order" }).matches.map((m) => m.name)).toEqual([
      "conn_erp__cancel_order",
    ]);
    const crm = searchCatalog(deferred, { connector: "CRM" });
    expect(crm.matches.map((m) => m.name)).toEqual(["conn_crm__find_contact"]);
    expect(searchCatalog(deferred, { connector: "cr" }).matches).toEqual([]);
    // Same query, same answer.
    expect(searchCatalog(deferred, { words: "report" })).toEqual(
      searchCatalog(deferred, { words: "report" }),
    );
  });

  it("returns at most `limit` definitions and says how many more matched", () => {
    const out = searchCatalog(deferred, { connector: "erp", limit: 3 });
    expect(out.matches).toHaveLength(3);
    expect(out.more).toHaveLength(10);
    expect(searchCatalog(deferred, { connector: "erp", limit: 500 }).matches).toHaveLength(10);
  });

  it("matches argument names too", () => {
    const out = searchCatalog(deferred, { words: "query" });
    expect(out.matches.length + out.more.length).toBe(deferred.length);
  });
});

describe("meta fallback: index + search_tools + use_tool", () => {
  const script = () => [
    use(call("c1", "search_tools", { words: "cancel sales order" })),
    use(call("c2", "use_tool", { tool: "conn_erp__cancel_order", arguments: { query: "A-1" } })),
    use(finishCall("f1", "Done.")),
  ];

  it("search -> load -> call: the card is the REAL tool's, the result is the real tool's", async () => {
    const s = setup("meta", script());
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("waiting_approval");
    const events = await s.rig.events();

    const catalog = catalogOf(events);
    expect(catalog?.payload.mode).toBe("meta");
    expect(catalog?.payload.deferred).toHaveLength(14);

    // The first request: built-ins, control tools and the two search tools; no connector definition.
    const first = s.rig.provider.requests[0];
    void first;
    const requests = eventsOfType(events, "model_request");
    const names = toolNames(requests[0]?.payload as never);
    expect(names).toEqual(
      expect.arrayContaining(["plan", "finish", "search_tools", "use_tool", "echo"]),
    );
    expect(names.filter((n) => n.startsWith("conn_"))).toEqual([]);
    expect(requests[0]?.payload.system).toContain(
      "- conn_erp__cancel_order: Cancel a sales order for good.",
    );

    // The search result carries the full definition (schema as JSON), as data from outside.
    const [search] = eventsOfType(events, "tool_result");
    expect(search?.payload.content).toContain("### conn_erp__cancel_order");
    expect(search?.payload.content).toContain('"query":{"type":"string"}');
    expect(search?.payload.content).toContain("<<<EXTERNAL_DATA");

    // The card shows the real tool, never the wrapper.
    const [card] = eventsOfType(events, "approval_requested");
    expect(card?.payload).toMatchObject({
      callId: "c2",
      tool: "conn_erp__cancel_order",
      args: { query: "A-1" },
      level: "external_irreversible",
      summary: "Conector erp → conn_erp__cancel_order A-1",
    });
    expect(sent).toEqual([]);
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "approved",
    });
    s.rig.store.claimNext("w");
    const answered = eventsOfType(await s.rig.events(), "model_response").length;
    expect(
      await runLoop(s.deps({ provider: new FakeProvider(s.script.slice(answered)) }), s.rig.runId),
    ).toBe("done");
    expect(sent).toEqual(["conn_erp__cancel_order:A-1"]);
    const after = await s.rig.events();
    // The tool_call event of the wrapped call is logged as the real tool.
    const started = eventsOfType(after, "tool_call").filter((e) => e.payload.callId === "c2");
    expect(started[0]?.payload).toMatchObject({
      name: "conn_erp__cancel_order",
      args: { query: "A-1" },
    });
    const result = eventsOfType(after, "tool_result").find((e) => e.payload.callId === "c2");
    expect(result?.payload.content).toContain("<<<EXTERNAL_DATA"); // labelled as the real tool's output
    expect(result?.payload.content).toContain("conn_erp__cancel_order ok for A-1");
  });

  it("the tools of every request are the same, byte for byte, and the conversation only grows", async () => {
    const s = setup("meta", [
      use(call("c1", "search_tools", { connector: "crm" })),
      use(call("c2", "use_tool", { tool: "conn_crm__find_contact", arguments: { query: "ana" } })),
      use(call("c3", "use_tool", { tool: "conn_erp__search_orders", arguments: { query: "x" } })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const requests = eventsOfType(await s.rig.events(), "model_request").map((e) => e.payload);
    expect(requests).toHaveLength(4);
    for (const r of requests) {
      expect(JSON.stringify(r.tools)).toBe(JSON.stringify(requests[0]?.tools));
      expect(r.system).toBe(requests[0]?.system);
    }
    for (let i = 1; i < requests.length; i++) {
      const before = JSON.stringify(requests[i - 1]?.messages.slice(0, -1));
      expect(JSON.stringify(requests[i]?.messages).startsWith(before.slice(0, -1))).toBe(true);
    }
  });

  it("a tool that was not granted cannot be reached: not through use_tool, not by name", async () => {
    // `conn_erp__report_0` exists in the registry but is not among the candidates of this bot.
    const { candidates } = connectorTools();
    const granted = candidates.filter((c) => c.name !== "conn_erp__report_0");
    const s = setup(
      "meta",
      [
        use(call("c1", "use_tool", { tool: "conn_erp__report_0", arguments: { query: "x" } })),
        use(call("c2", "use_tool", { tool: "echo", arguments: { text: "x" } })),
        use(call("c3", "conn_erp__search_orders", { query: "x" })),
        use(call("c4", "search_tools", { words: "report 0" })),
        use(finishCall("f1", "Done.")),
      ],
      { candidates: granted },
    );
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const results = eventsOfType(await s.rig.events(), "tool_result");
    const byId = (id: string) => results.find((r) => r.payload.callId === id)?.payload;
    expect(byId("c1")).toMatchObject({ outcome: "unknown_tool", isError: true });
    expect(byId("c2")).toMatchObject({ outcome: "unknown_tool", isError: true });
    expect(byId("c3")).toMatchObject({ outcome: "unknown_tool", isError: true });
    expect(byId("c3")?.content).toContain("use_tool");
    // The search never finds it either.
    expect(byId("c4")?.content).not.toContain("conn_erp__report_0");
    expect(sent).toEqual([]);
  });

  it("invalid arguments come back with the real schema, then the corrected call runs", async () => {
    const s = setup("meta", [
      use(call("c1", "use_tool", { tool: "conn_crm__find_contact", arguments: { limit: "ten" } })),
      use(call("c2", "use_tool", { tool: "conn_crm__find_contact", arguments: { query: "ana" } })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const results = eventsOfType(await s.rig.events(), "tool_result");
    const bad = results.find((r) => r.payload.callId === "c1")?.payload;
    expect(bad).toMatchObject({ outcome: "invalid_args", isError: true });
    expect(bad?.content).toContain("query");
    expect(bad?.content).toContain('The input schema of "conn_crm__find_contact" (JSON):');
    expect(bad?.content).toContain('"properties"');
    expect(results.find((r) => r.payload.callId === "c2")?.payload.outcome).toBe("ok");
    expect(sent).toEqual(["conn_crm__find_contact:ana"]);
  });

  it("use_tool without the required fields is an argument error, not a crash", async () => {
    const s = setup("meta", [
      use(call("c1", "use_tool", { arguments: {} })),
      use(finishCall("f1", "ok")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const [r] = eventsOfType(await s.rig.events(), "tool_result");
    expect(r?.payload).toMatchObject({ outcome: "invalid_args", isError: true });
  });

  it("a replay of the recorded run is identical", async () => {
    const s = setup("meta", [
      use(planCall("p1", [{ id: "s1", title: "Look", status: "in_progress" }])),
      use(call("c1", "search_tools", { words: "find contact" })),
      use(call("c2", "use_tool", { tool: "conn_crm__find_contact", arguments: { query: "ana" } })),
      use(planCall("p2", [{ id: "s1", title: "Look", status: "done" }])),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });

  it("a run without connector tools records no catalog and offers no search tool", async () => {
    const s = setup("meta", [use(finishCall("f1", "Done."))], { candidates: [] });
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const events = await s.rig.events();
    expect(eventsOfType(events, "tool_catalog")).toHaveLength(0);
    expect(toolNames(eventsOfType(events, "model_request")[0]?.payload as never)).not.toContain(
      "search_tools",
    );
  });

  it("the size of the definitions of each request is recorded", async () => {
    const meta = setup("meta", [use(finishCall("f1", "Done."))]);
    await runLoop(meta.deps(), meta.rig.runId);
    const direct = setup("direct", [use(finishCall("f1", "Done."))]);
    await runLoop(direct.deps(), direct.rig.runId);
    const m = eventsOfType(await meta.rig.events(), "model_request")[0]?.payload.toolStats;
    const d = eventsOfType(await direct.rig.events(), "model_request")[0]?.payload.toolStats;
    expect(m?.deferred).toBe(0);
    expect(d?.definitions).toBeGreaterThan((m?.definitions ?? 0) + 10);
    expect(d?.estimatedTokens).toBeGreaterThan(m?.estimatedTokens ?? 0);
  });
});

describe("direct (below the threshold)", () => {
  it("offers every connector tool in every request and has no search tools", async () => {
    const s = setup("direct", [
      use(call("c1", "conn_crm__find_contact", { query: "ana" })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const events = await s.rig.events();
    expect(catalogOf(events)?.payload).toMatchObject({ mode: "direct", deferred: [] });
    const names = toolNames(eventsOfType(events, "model_request")[0]?.payload as never);
    expect(names).toEqual(expect.arrayContaining(CONNECTOR_NAMES));
    expect(names).not.toContain("search_tools");
  });
});

describe("native deferred loading", () => {
  it("hosted: the connector definitions go last, marked as deferred, with the hosted search asked for", async () => {
    const s = setup("hosted", [
      use(call("c1", "conn_crm__find_contact", { query: "ana" })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const events = await s.rig.events();
    expect(catalogOf(events)?.payload).toMatchObject({ mode: "hosted", variant: "bm25" });
    const requests = eventsOfType(events, "model_request").map((e) => e.payload);
    for (const r of requests) {
      expect(r.hostedToolSearch).toBe("bm25");
      expect(JSON.stringify(r.tools)).toBe(JSON.stringify(requests[0]?.tools));
      const flags = r.tools.map((t) => t.deferLoading === true);
      // Non-deferred first, deferred last (the order never changes).
      expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
      expect(r.tools.filter((t) => t.deferLoading === true).map((t) => t.name)).toEqual(
        CONNECTOR_NAMES,
      );
      expect(r.tools.some((t) => t.name === "search_tools")).toBe(false);
      expect(r.toolStats?.deferred).toBe(14);
      expect(r.toolStats?.loadedTokens ?? 0).toBeLessThan(r.toolStats?.estimatedTokens ?? 0);
    }
    // The model called a tool it discovered through the provider's search: same gate, same registry.
    const [result] = eventsOfType(events, "tool_result");
    expect(result?.payload.content).toContain("conn_crm__find_contact ok for ana");
    expect(catalogOf(events)?.payload.index).toContain("- erp: 13 tool(s)");
  });

  it("client: search_tools names the tools to load and the result carries the references", async () => {
    const s = setup("client", [
      use(call("c1", "search_tools", { words: "find contact" })),
      use(call("c2", "conn_crm__find_contact", { query: "ana" })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await runLoop(s.deps(), s.rig.runId)).toBe("done");
    const events = await s.rig.events();
    expect(catalogOf(events)?.payload.mode).toBe("client");
    const [search] = eventsOfType(events, "tool_result");
    expect(search?.payload.toolReferences).toEqual(["conn_crm__find_contact"]);
    const requests = eventsOfType(events, "model_request").map((e) => e.payload);
    expect(requests[0]?.hostedToolSearch).toBeUndefined();
    expect(toolNames(requests[0] as never)).toContain("search_tools");
    // The second request carries the reference inside the conversation.
    const toolResult = requests[1]?.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ toolReferences: ["conn_crm__find_contact"] });
    for (const r of requests)
      expect(JSON.stringify(r.tools)).toBe(JSON.stringify(requests[0]?.tools));
  });

  it("a replay of a hosted run is identical", async () => {
    const s = setup("hosted", [
      use(call("c1", "conn_crm__find_contact", { query: "ana" })),
      use(finishCall("f1", "Done.")),
    ]);
    await runLoop(s.deps(), s.rig.runId);
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.identical).toBe(true);
  });
});

describe("crash and resume with deferred tools", () => {
  const SCRIPT = () => [
    use(call("c1", "search_tools", { words: "find contact" })),
    use(call("c2", "use_tool", { tool: "conn_crm__find_contact", arguments: { query: "ana" } })),
    use(call("c3", "use_tool", { tool: "conn_erp__cancel_order", arguments: { query: "A-1" } })),
    use(finishCall("f1", "Done.")),
  ];

  async function drive(crashAfter?: number): Promise<{ status: RunStatus; events: StoredEvent[] }> {
    const s = setup("meta", SCRIPT());
    for (let life = 0; life < 40; life++) {
      const answered = eventsOfType(await s.rig.events(), "model_response").length;
      const deps = s.deps({
        provider: new FakeProvider(s.script.slice(answered)),
        ...(life === 0 && crashAfter !== undefined
          ? { store: new CrashingStore(s.rig.store, crashAfter) }
          : {}),
      });
      let status: RunStatus;
      try {
        status = await runLoop(deps, s.rig.runId);
      } catch (error) {
        if (error instanceof SimulatedCrash) continue;
        throw error;
      }
      if (status !== "waiting_approval") return { status, events: await s.rig.events() };
      const events = await s.rig.events();
      const card = eventsOfType(events, "approval_requested").find(
        (c) =>
          !eventsOfType(events, "approval_decided").some(
            (d) => d.payload.callId === c.payload.callId,
          ),
      );
      if (card === undefined) throw new Error("waiting for nobody");
      s.rig.store.decideApproval(s.rig.runId, card.payload.approvalId, { decision: "approved" });
      if ((await s.rig.record()).status === "queued") s.rig.store.claimNext("w");
    }
    throw new Error("did not settle");
  }

  it("resumes from any crash point: one catalog, the same tools in every request, the same cards", async () => {
    const base = await drive();
    expect(base.status).toBe("done");
    const resultsOf = (events: readonly StoredEvent[]) =>
      new Map(eventsOfType(events, "tool_result").map((e) => [e.payload.callId, e.payload]));
    const baseResults = resultsOf(base.events);
    for (let k = 1; k <= base.events.length + 2; k += 2) {
      const crashed = await drive(k);
      expect(crashed.status).toBe("done");
      expect(eventsOfType(crashed.events, "tool_catalog")).toHaveLength(1);
      expect(eventsOfType(crashed.events, "tool_catalog")[0]?.payload).toEqual(
        eventsOfType(base.events, "tool_catalog")[0]?.payload,
      );
      // A call the crash caught between its start and its result is reported as interrupted (the
      // action may have happened): any other result is the one of the run that did not crash.
      for (const [id, result] of resultsOf(crashed.events)) {
        const expected = baseResults.get(id);
        if (result.outcome === "aborted") continue;
        expect(result.content).toBe(expected?.content);
      }
      expect(eventsOfType(crashed.events, "approval_requested").map((e) => e.payload.tool)).toEqual(
        eventsOfType(base.events, "approval_requested").map((e) => e.payload.tool),
      );
      const requests = eventsOfType(crashed.events, "model_request").map((e) => e.payload.tools);
      for (const t of requests) expect(JSON.stringify(t)).toBe(JSON.stringify(requests[0]));
    }
  });
});
