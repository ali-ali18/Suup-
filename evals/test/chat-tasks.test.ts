import { describe, expect, it } from "vitest";
import {
  CHAT_TASK_CASES,
  CHAT_TASK_CATEGORIES,
  type ChatTaskReport,
  formatChatTaskReport,
  percentile,
} from "../src/index.js";

describe("the chat-or-task cases (KOD-68)", () => {
  it("has 30 to 40 cases with unique ids, some of every category", () => {
    expect(CHAT_TASK_CASES.length).toBeGreaterThanOrEqual(30);
    expect(CHAT_TASK_CASES.length).toBeLessThanOrEqual(40);
    expect(new Set(CHAT_TASK_CASES.map((c) => c.id)).size).toBe(CHAT_TASK_CASES.length);
    for (const category of CHAT_TASK_CATEGORIES) {
      expect(CHAT_TASK_CASES.filter((c) => c.category === category).length).toBeGreaterThanOrEqual(
        6,
      );
    }
  });

  it("states each expectation the way its category is scored", () => {
    for (const c of CHAT_TASK_CASES) {
      if (c.category === "quick") expect(c.expect.tasks, c.id).toBe(0);
      if (c.category === "long") expect(c.expect.tasks, c.id).toBe(1);
      if (c.category === "followup") {
        expect(c.before, c.id).toBeDefined();
        expect(c.expect.forward, c.id).toBeTypeOf("boolean");
      } else {
        expect(c.before, c.id).toBeUndefined();
        expect(c.expect.forward, c.id).toBeUndefined();
      }
    }
  });

  it("writes every folder a message points at, inside the case's own folder", () => {
    for (const c of CHAT_TASK_CASES) {
      for (const path of Object.keys(c.files ?? {})) {
        expect(path.startsWith("/") || path.split("/").includes(".."), `${c.id}: ${path}`).toBe(
          false,
        );
      }
    }
    // A case that reads what is there has files; one that only creates (the site, a note) may not.
    const reads = CHAT_TASK_CASES.filter((c) => c.id === "q-porta" || c.id === "l-csv");
    for (const c of reads) expect(Object.keys(c.files ?? {}).length, c.id).toBeGreaterThan(0);
  });

  it("interleaves the categories so a budget stop leaves some of each", () => {
    expect(CHAT_TASK_CASES.slice(0, 4).map((c) => c.category)).toEqual([...CHAT_TASK_CATEGORIES]);
  });
});

describe("the report", () => {
  it("takes the nearest-rank percentile", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90);
  });

  it("puts each category beside the earlier run, with latency and cost", () => {
    const report: ChatTaskReport = {
      variant: "b",
      model: "model-x",
      results: [
        {
          id: "l-csv",
          category: "long",
          passed: true,
          why: "",
          status: "done",
          tasks: 1,
          expectedTasks: 1,
          byBot: 0,
          byBrake: true,
          stepsBeforeTask: 4,
          forwarded: null,
          unhandledAsks: null,
          turns: 5,
          toolCalls: 4,
          capped: false,
          firstReplyMs: 30_000,
          endMs: 31_000,
          costUsd: 0.01,
        },
      ],
      categories: [
        {
          category: "quick",
          passed: 0,
          total: 0,
          baseline: { passed: 7, total: 7 },
          failedIds: [],
        },
        { category: "long", passed: 1, total: 1, baseline: { passed: 3, total: 6 }, failedIds: [] },
        {
          category: "multi",
          passed: 0,
          total: 0,
          baseline: { passed: 1, total: 3 },
          failedIds: [],
        },
        { category: "followup", passed: 0, total: 0, baseline: null, failedIds: [] },
      ],
      totalCostUsd: 0.01,
      notRun: ["q-oi"],
    };
    const text = formatChatTaskReport(report).join("\n");
    expect(text).toContain("1/1 (antes 3/6)");
    expect(text).toContain("0 pelo próprio bot, 1 pelo freio");
    expect(text).toContain("sem referência anterior");
    expect(text).toContain("NÃO RODARAM (orçamento): q-oi");
  });
});
