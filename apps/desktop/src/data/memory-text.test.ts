import { describe, expect, it } from "vitest";
import { ACTOR_LABEL, charsLabel, REVISION_KIND_LABEL } from "./memory-text.js";

describe("what the memory screens say", () => {
  it("says who made a change, and what it was, for every actor and kind the API has", () => {
    expect(ACTOR_LABEL).toEqual({
      user: "Você",
      bot: "O bot",
      consolidation: "Consolidação",
      expiry: "Validade",
    });
    expect(Object.keys(REVISION_KIND_LABEL).sort()).toEqual(
      [
        "archived",
        "confirmed",
        "created",
        "edited",
        "promoted",
        "rejected",
        "restored",
        "undone",
      ].sort(),
    );
  });

  it("writes a count of characters the way a person reads it", () => {
    expect(charsLabel(6000)).toBe((6000).toLocaleString("pt-BR"));
    expect(charsLabel(6000)).toContain("6");
  });
});
