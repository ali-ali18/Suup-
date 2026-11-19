import { describe, expect, it } from "vitest";
import {
  HOST_EMPTY,
  hostInput,
  hostLines,
  hostsText,
  RUNS_IN_LABEL,
  refusalLabel,
  sameHosts,
} from "./network.js";

describe("the host typed for a bot", () => {
  it("is refused only when empty; every other judgement is the server's", () => {
    expect(hostInput("")).toEqual({ ok: false, message: HOST_EMPTY });
    expect(hostInput("   \n")).toEqual({ ok: false, message: HOST_EMPTY });
    expect(hostInput("  api.exemplo.com ")).toEqual({ ok: true, host: "api.exemplo.com" });
    // Not the app's business: the server refuses these and says why.
    for (const text of ["10.0.0.1", "localhost", "*.exemplo.com", "https://x.com/a"]) {
      expect(hostInput(text)).toEqual({ ok: true, host: text });
    }
  });
});

describe("the hosts of a connector", () => {
  it("one per line, trimmed, blanks and repeats dropped", () => {
    expect(hostLines(" a.com \n\nb.com\na.com\n  ")).toEqual(["a.com", "b.com"]);
    expect(hostLines("")).toEqual([]);
  });

  it("round-trips through the field and knows when it is unchanged", () => {
    expect(hostsText(["a.com", "b.com"])).toBe("a.com\nb.com");
    expect(hostsText(undefined)).toBe("");
    expect(sameHosts("a.com\nb.com\n", ["a.com", "b.com"])).toBe(true);
    expect(sameHosts("a.com", ["a.com", "b.com"])).toBe(false);
    expect(sameHosts("", undefined)).toBe(true);
  });

  it("says where a program runs", () => {
    expect(RUNS_IN_LABEL.container).toBe("em contêiner isolado");
    expect(RUNS_IN_LABEL.host).toBe("no servidor, sem isolamento");
  });
});

describe("a refusal of the proxy", () => {
  it("is put in words, and an unknown code is shown as it came", () => {
    expect(refusalLabel("not_allowed")).toContain("não está na lista");
    expect(refusalLabel("ip_literal")).toContain("IP");
    expect(refusalLabel("novo_codigo")).toBe("novo_codigo");
  });
});
