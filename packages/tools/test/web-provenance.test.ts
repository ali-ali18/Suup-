// The addresses `web_read` may open without a card (docs/BUSCA.md): the real tools, the real gate
// and the real loop, with a fake web. The provenance of each read is recorded in the log, and a
// replay reproduces it without reading anything.
import { createToolGate, replayRun, runLoop, type WebAccess, type WebPage } from "@suup/core";
import {
  call,
  createRig,
  eventsOfType,
  type FakeStep,
  type Rig,
  say,
  testTools,
  use,
} from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { webReadTool, webSearchTool } from "../src/index.js";

const ALLOWED = ["web_search", "web_read"];

function page(url: string, links: string[]): WebPage {
  return {
    url,
    requestedUrl: url,
    status: 200,
    extraction: "readability",
    markdown: `Page ${url}`,
    links,
    truncated: false,
    fullLength: 10,
    rendered: false,
  };
}

function fakeWeb(reads: string[]): WebAccess {
  return {
    searchAvailable: true,
    readerEnabled: true,
    renderAvailable: false,
    async search(request) {
      return {
        ok: true,
        query: request.query,
        engines: ["wikipedia"],
        suspended: [],
        hits: [
          { title: "One", url: "https://found.example/one#top", snippet: "s", engine: "wikipedia" },
        ],
      };
    },
    async read(request) {
      reads.push(request.url);
      return {
        ok: true,
        page: page(request.url, ["https://user.example/next", "https://other.example/x?y=1"]),
      };
    },
    extract: async () => undefined,
  };
}

interface Setup {
  rig: Rig;
  reads: string[];
  script: FakeStep[];
}

function setup(script: FakeStep[], objective = "Do the task."): Setup {
  const reads: string[] = [];
  const rig = createRig({
    script,
    objective,
    tools: [...testTools(), webSearchTool, webReadTool],
    bot: { allowedTools: ALLOWED },
  });
  return { rig, reads, script };
}

function run(s: Setup, over: Partial<Parameters<Rig["deps"]>[0]> = {}) {
  const web = fakeWeb(s.reads);
  const gate = createToolGate({
    tools: s.rig.registry,
    rules: { rulesFor: async () => [] },
    now: () => new Date(s.rig.clock.now),
  });
  return runLoop(s.rig.deps({ gate, webFor: () => web, ...over }), s.rig.runId);
}

const cards = async (s: Setup) => eventsOfType(await s.rig.events(), "approval_requested");
const results = async (s: Setup) => eventsOfType(await s.rig.events(), "tool_result");

describe("web_read: which addresses are read without a card", () => {
  it("one the user wrote is read at once, and the log says where it came from", async () => {
    const s = setup(
      [use(call("c1", "web_read", { url: "https://User.example:443/doc#intro" })), say("done")],
      "Leia https://user.example/doc, por favor.",
    );
    expect(await run(s)).toBe("done");
    expect(await cards(s)).toHaveLength(0);
    expect(s.reads).toEqual(["https://User.example:443/doc#intro"]);
    expect((await results(s))[0]?.payload.urlProvenance).toBe("user_message");
  });

  it("one a search result showed is read at once (the fragment does not matter)", async () => {
    const s = setup([
      use(call("c1", "web_search", { query: "something here" })),
      use(call("c2", "web_read", { url: "https://found.example/one" })),
      say("done"),
    ]);
    expect(await run(s)).toBe("done");
    expect(await cards(s)).toHaveLength(0);
    const [search, read] = await results(s);
    expect(search?.payload.webUrls).toEqual(["https://found.example/one"]);
    expect(read?.payload.urlProvenance).toBe("search_result");
  });

  it("a link of a page that was read is read at once, resolved against the page", async () => {
    const s = setup(
      [
        use(call("c1", "web_read", { url: "https://user.example/doc" })),
        use(call("c2", "web_read", { url: "https://user.example/next" })),
        use(call("c3", "web_read", { url: "https://other.example/x?y=1" })),
        say("done"),
      ],
      "Veja https://user.example/doc",
    );
    expect(await run(s)).toBe("done");
    expect(await cards(s)).toHaveLength(0);
    const out = await results(s);
    expect(out.map((r) => r.payload.urlProvenance)).toEqual([
      "user_message",
      "page_link",
      "page_link",
    ]);
    expect(out[0]?.payload.webUrls).toContain("https://user.example/next");
  });

  it("an address that is only close to a known one is a card: trailing slash, another query", async () => {
    for (const url of ["https://found.example/one/", "https://found.example/one?x=1"]) {
      const s = setup([
        use(call("c1", "web_search", { query: "something here" })),
        use(call("c2", "web_read", { url })),
        say("done"),
      ]);
      expect(await run(s)).toBe("waiting_approval");
      const [card] = await cards(s);
      expect(card?.payload).toMatchObject({
        tool: "web_read",
        level: "external_irreversible",
        summary: `Read a new page: ${url}`,
      });
      expect(s.reads).toEqual([]);
    }
  });

  it("a new address asks; approving reads it, and the log says it was approved", async () => {
    const s = setup([
      use(call("c1", "web_read", { url: "https://new.example/a?secret=1" })),
      say("done"),
    ]);
    expect(await run(s)).toBe("waiting_approval");
    const [card] = await cards(s);
    expect(card?.payload.summary).toBe("Read a new page: https://new.example/a?secret=1");
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "approved",
    });
    expect(s.rig.store.claimNext("worker-1")?.id).toBe(s.rig.runId);
    expect(await run(s)).toBe("done");
    expect(s.reads).toEqual(["https://new.example/a?secret=1"]);
    expect((await results(s))[0]?.payload.urlProvenance).toBe("approved");
  });

  it("a new address asks; denying reads nothing", async () => {
    const s = setup([use(call("c1", "web_read", { url: "https://new.example/a" })), say("ok")]);
    expect(await run(s)).toBe("waiting_approval");
    const [card] = await cards(s);
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "denied",
      reason: "no",
    });
    expect(s.rig.store.claimNext("worker-1")?.id).toBe(s.rig.runId);
    expect(await run(s)).toBe("done");
    expect(s.reads).toEqual([]);
    expect((await results(s))[0]?.payload.outcome).toBe("denied");
  });

  it("a replay of a run with approved and cleared reads gives the same log and reads nothing", async () => {
    const s = setup(
      [
        use(call("c1", "web_read", { url: "https://user.example/doc" })),
        use(call("c2", "web_read", { url: "https://user.example/next" })),
        say("done"),
      ],
      "Veja https://user.example/doc",
    );
    expect(await run(s)).toBe("done");
    const readsBefore = s.reads.length;
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(s.reads.length).toBe(readsBefore);
  });
});
