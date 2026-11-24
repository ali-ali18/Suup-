import { join } from "node:path";
import type { RunEnd } from "@suup/core";
import { type Bot, createBot, getFile, getRun, listMessages, listRunEvents } from "@suup/db";
import { describe, expect, it } from "vitest";
import { createRuntime, parseConfig, type Runtime, sendMessage } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// `send_file` end to end with a real Postgres, the scripted provider and the local sandbox: the bot
// makes a file on its machine, sends it, and its message in the chat carries the file.

const call = (name: string, args: unknown = {}) => ({ name, args });

describe.skipIf(!DATABASE_URL)(dbSuiteName("send_file in a conversation"), () => {
  const ctx = useIsolatedDb();

  async function open(script: unknown): Promise<Runtime> {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    return createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
  }

  function work(runtime: Runtime, runId: string): Promise<RunEnd> {
    return new Promise((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: runId,
        idleBackoff: { minMs: 5, maxMs: 20 },
        onRunEnd: (end) => void worker.stop().then(() => resolve(end)),
      });
      worker.start();
    });
  }

  it("a bot made before the tool existed (machine tools only) gets it; the file goes under its final message", async () => {
    const runtime = await open({
      agent: [
        {
          calls: [call("write_file", { path: "pesquisa/historia.txt", content: "Historia oi" })],
        },
        { calls: [call("send_file", { path: "pesquisa/historia.txt" })] },
        { text: "Aqui está o PDF da história." },
      ],
    });
    const bot: Bot = await createBot(runtime.db, {
      name: "Pesquisador",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["write_file"],
    });
    const first = await sendMessage(runtime, { botId: bot.id, text: "Faça o PDF" });
    await work(runtime, first.run.id);
    expect((await getRun(runtime.db, first.run.id))?.status).toBe("done");

    const events = await listRunEvents(runtime.db, first.run.id);
    const sent = events.find(
      (e) => e.type === "tool_result" && JSON.stringify(e.payload).includes("Sent "),
    );
    expect(JSON.stringify(sent?.payload)).toContain('Sent \\"historia.txt\\"');

    const messages = await listMessages(runtime.db, first.message.conversationId, { limit: 10 });
    const answer = messages.find((m) => m.authorKind === "bot");
    expect(answer?.text).toBe("Aqui está o PDF da história.");
    expect(answer?.attachments).toEqual([
      { id: expect.any(String), name: "historia.txt", mime: "text/plain", size: 11 },
    ]);
    const stored = await getFile(runtime.db, answer?.attachments?.[0]?.id ?? "");
    expect(Buffer.from(stored?.content ?? []).toString("utf8")).toBe("Historia oi");
    expect(stored?.botId).toBe(bot.id);
    await runtime.close();
  });

  it("the model is offered the tool and told to send files instead of writing the path", async () => {
    const runtime = await open({ agent: [{ text: "Oi!" }] });
    const bot = await createBot(runtime.db, {
      name: "Outro",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["read_file", "write_file"],
    });
    // Counted in what the bot is offered: its two file tools, send_file and create_document; a bot
    // with no machine tools gets neither.
    const bare = await createBot(runtime.db, {
      name: "Sem máquina",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: [],
    });
    const offered = (await runtime.toolReport(bot.id)).builtinTools;
    expect(offered - (await runtime.toolReport(bare.id)).builtinTools).toBe(4);
    const first = await sendMessage(runtime, { botId: bot.id, text: "oi" });
    await work(runtime, first.run.id);
    const events = await listRunEvents(runtime.db, first.run.id);
    const request = JSON.stringify(events.filter((e) => e.type === "model_request"));
    expect(request).toContain("send_file");
    expect(request).toContain("create_document");
    await runtime.close();
  });
});
