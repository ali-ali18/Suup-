import { describe, expect, it } from "vitest";
import { makeEvent } from "../test-fixtures.js";
import { CATALOG_LABEL, catalogOf, requestToolStats } from "./tool-stats.js";

const stats = { definitions: 14, deferred: 12, estimatedTokens: 5200, loadedTokens: 600 };

describe("the tool definitions of a run's requests", () => {
  it("lists the requests that carry toolStats, in order, with their purpose", () => {
    const events = [
      makeEvent(1, "run_started"),
      makeEvent(2, "model_request", { omitted: true, toolCount: 14, toolStats: stats }),
      makeEvent(3, "model_response", {}),
      makeEvent(4, "model_request", { purpose: "review", toolStats: { ...stats, deferred: 0 } }),
    ];
    expect(requestToolStats(events)).toEqual([
      { seq: 2, purpose: "agent", ...stats },
      { seq: 4, purpose: "review", ...stats, deferred: 0 },
    ]);
  });

  it("skips old requests with no measure and anything malformed", () => {
    const events = [
      makeEvent(1, "model_request", { omitted: true, toolCount: 3 }),
      makeEvent(2, "model_request", { toolStats: { definitions: "muitas" } }),
      makeEvent(3, "model_request", { toolStats: null }),
      makeEvent(4, "tool_call", { toolStats: stats }),
    ];
    expect(requestToolStats(events)).toEqual([]);
  });
});

describe("how the run offers its connector tools", () => {
  const catalog = (mode: string, extra: Record<string, unknown> = {}) =>
    makeEvent(5, "tool_catalog", {
      mode,
      settings: { minTools: 10, minDefinitionTokens: 1000 },
      connectorTools: 14,
      definitionTokens: 5200,
      deferred: [{ name: "a" }, { name: "b" }],
      ...extra,
    });

  it("reads the mode and the sizes", () => {
    expect(catalogOf([catalog("meta")])).toEqual({
      mode: "meta",
      connectorTools: 14,
      definitionTokens: 5200,
      deferred: 2,
    });
    expect(catalogOf([catalog("direct", { deferred: [] })])?.deferred).toBe(0);
  });

  it("names the three modes the way the screen does (the two native ones are one)", () => {
    expect(CATALOG_LABEL.direct).toBe("direto");
    expect(CATALOG_LABEL.hosted).toBe("pesquisa nativa");
    expect(CATALOG_LABEL.client).toBe("pesquisa nativa");
    expect(CATALOG_LABEL.meta).toBe("pesquisa por índice");
  });

  it("has no catalog when the run has none, or when the mode is unknown", () => {
    expect(catalogOf([makeEvent(1, "run_started")])).toBeUndefined();
    expect(catalogOf([catalog("outro")])).toBeUndefined();
  });
});
