import { describe, expect, it } from "vitest";
import { runEventSchema } from "../src/index.js";

const loaded = (memoryOmitted: unknown) => ({
  type: "context_loaded",
  payload: { rules: [], profile: [], history: [], memoryOmitted },
});

// The recorded context is what a replay uses: a log written when the limit was in characters
// (`limitChars`) must still parse, next to the new shape (`limitItems`, `ceilingChars`).
describe("context_loaded.memoryOmitted", () => {
  it("parses the new shape, in memories with the character ceiling", () => {
    const r = runEventSchema.safeParse(
      loaded({ count: 3, chars: 900, limitItems: 200, ceilingChars: 25_000 }),
    );
    expect(r.success).toBe(true);
  });

  it("still parses the old shape of a log recorded with a limit in characters", () => {
    const r = runEventSchema.safeParse(loaded({ count: 1, chars: 400, limitChars: 6000 }));
    expect(r.success).toBe(true);
    expect(r.data?.type === "context_loaded" && r.data.payload.memoryOmitted?.limitChars).toBe(
      6000,
    );
  });
});
