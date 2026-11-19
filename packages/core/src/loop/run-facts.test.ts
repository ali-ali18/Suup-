import { describe, expect, it } from "vitest";
import { z } from "zod";
import { call, createRig, say, use } from "../testing/index.js";
import { defineTool, type RunFacts } from "../tool.js";

describe("what a tool is told about its run (RunFacts)", () => {
  it("has the user's own messages and the names of the tools that already ran, never denied or unknown ones", async () => {
    const seen: RunFacts[] = [];
    const spy = defineTool({
      name: "spy",
      description: "reads the facts",
      input: z.object({}),
      risk: "read",
      async execute(_input, ctx) {
        if (ctx.runFacts !== undefined) seen.push(structuredClone(ctx.runFacts) as RunFacts);
        return { content: "ok" };
      },
    });
    const page = defineTool({
      name: "page",
      description: "fetches a page",
      input: z.object({}),
      risk: "read",
      externalOutput: true,
      async execute() {
        return { content: "outside text" };
      },
    });
    const rig = createRig({
      objective: "Resuma a página para mim",
      tools: [spy, page],
      bot: { allowedTools: ["spy", "page"] },
      script: [
        use(call("c1", "spy", {})),
        use(call("c2", "page", {})),
        use(call("c3", "nothing_like_this", {})),
        use(call("c4", "spy", {})),
        say("done"),
      ],
    });
    await rig.run();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ userMessages: ["Resuma a página para mim"], toolsUsed: [] });
    expect(seen[1]?.toolsUsed).toEqual(["spy", "page"]);
    expect(seen[1]?.userMessages).toEqual(["Resuma a página para mim"]);
  });
});
