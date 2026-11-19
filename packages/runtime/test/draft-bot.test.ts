import { ProviderError } from "@suup/core";
import { call, FakeProvider, type FakeStep, use } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { draftBot, type Runtime, RuntimeError } from "../src/index.js";

const VALID = {
  name: "Lia",
  description: "Ajuda com os estudos de inglês.",
  personality: "Você é a Lia, uma professora de inglês paciente e animada. Corrija com gentileza.",
};

/** The two things `draftBot` uses of the runtime. */
function stub(steps: FakeStep[], model: { supportsForcedToolChoice?: boolean } = {}) {
  const provider = new FakeProvider(steps);
  const runtime = {
    resolveModel: () => ({
      model: {
        id: "model-x",
        provider: "p",
        maxOutputTokens: 4096,
        contextWindow: 100000,
        ...model,
      },
      provider: { id: "p" },
    }),
    getProvider: () => provider,
  } as unknown as Runtime;
  return { runtime, provider };
}

describe("draftBot", () => {
  it("asks once with a single forced tool and returns the validated proposal", async () => {
    const { runtime, provider } = stub([use(call("d1", "propose_bot", VALID))]);
    const draft = await draftBot(runtime, {
      description: "Uma professora de inglês paciente",
      modelId: "model-x",
    });
    expect(draft).toEqual(VALID);
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0];
    expect(req?.tools.map((t) => t.name)).toEqual(["propose_bot"]);
    expect(req?.toolChoice).toEqual({ name: "propose_bot" });
    expect(JSON.stringify(req?.messages)).toContain("Uma professora de inglês paciente");
    expect(req?.system).toContain("Brazilian Portuguese");
    // The tool schema carries what the model must fill in.
    const schema = (req?.tools[0]?.inputSchema ?? {}) as { properties?: object };
    expect(Object.keys(schema.properties ?? {})).toEqual(["name", "description", "personality"]);
  });

  it("does not force the tool for a model that does not support it", async () => {
    const { runtime, provider } = stub([use(call("d1", "propose_bot", VALID))], {
      supportsForcedToolChoice: false,
    });
    await draftBot(runtime, { description: "x", modelId: "model-x" });
    expect(provider.requests[0]?.toolChoice).toBeUndefined();
  });

  it("repeats without the forced choice when the model rejects it", async () => {
    const { runtime, provider } = stub([
      new ProviderError("invalid_request", "tool_choice not supported", {
        retryable: false,
      }),
      use(call("d1", "propose_bot", VALID)),
    ]);
    expect(await draftBot(runtime, { description: "x", modelId: "model-x" })).toEqual(VALID);
    expect(provider.requests.map((r) => r.toolChoice)).toEqual([
      { name: "propose_bot" },
      undefined,
    ]);
  });

  it("retries once on a malformed answer, saying what was wrong", async () => {
    const { runtime, provider } = stub([
      use(call("d1", "propose_bot", { name: "", description: "d" })),
      use(call("d2", "propose_bot", VALID)),
    ]);
    expect(await draftBot(runtime, { description: "x", modelId: "model-x" })).toEqual(VALID);
    expect(provider.requests).toHaveLength(2);
    const second = JSON.stringify(provider.requests[1]?.messages);
    expect(second).toContain("Invalid");
    expect(second).toContain("personality");
  });

  it("retries when the model does not call the tool at all", async () => {
    const { runtime } = stub([
      { blocks: [{ type: "text", text: "Claro! Aqui vai..." }] },
      use(call("d2", "propose_bot", VALID)),
    ]);
    expect(await draftBot(runtime, { description: "x", modelId: "model-x" })).toEqual(VALID);
  });

  it("fails with a clear error after two bad answers, and when the call fails", async () => {
    const bad = use(call("d1", "propose_bot", { name: "só o nome" }));
    const { runtime } = stub([bad, use(call("d2", "propose_bot", { name: "só o nome" }))]);
    const error = await draftBot(runtime, { description: "x", modelId: "model-x" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ code: "draft_failed" });
    expect((error as Error).message).toContain("model-x");

    const { runtime: down } = stub([
      new ProviderError("auth", "chave inválida", { retryable: false }),
    ]);
    await expect(draftBot(down, { description: "x", modelId: "model-x" })).rejects.toMatchObject({
      code: "draft_failed",
    });
    await expect(draftBot(down, { description: "  ", modelId: "model-x" })).rejects.toMatchObject({
      code: "draft_failed",
    });
  });
});
