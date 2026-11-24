import { join } from "node:path";
import type { RunEnd } from "@suup/core";
import { createBot, getFile, getRun, listMessages, listRunEvents } from "@suup/db";
import { describe, expect, it } from "vitest";
import { createRuntime, parseConfig, type Runtime, sendMessage } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// `create_document` end to end with a real Postgres, the scripted provider and the local sandbox:
// the bot gives the content and the format, Suup builds and checks the file, and the file lands
// as an attachment of the bot's next message in the chat (the same path as `send_file`).

const call = (name: string, args: unknown = {}) => ({ name, args });

describe.skipIf(!DATABASE_URL)(dbSuiteName("create_document in a conversation"), () => {
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

  it("a PDF with the content and the format becomes a real file under the bot's next message", async () => {
    const runtime = await open({
      agent: [
        {
          calls: [
            call("create_document", {
              format: "pdf",
              name: "historia-biblioteca",
              content:
                "# História da biblioteca da cidade\n\nFundada em 1959.\n\n| Ano | Seções |\n| --- | --- |\n| 1959 | 3 |",
            }),
          ],
        },
        { text: "Pronto." },
      ],
    });
    // A bot made before the tool existed (a machine tool only) is offered it too.
    const bot = await createBot(runtime.db, {
      name: "Redatora",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["write_file"],
    });
    const first = await sendMessage(runtime, { botId: bot.id, text: "Faça o PDF" });
    await work(runtime, first.run.id);
    expect((await getRun(runtime.db, first.run.id))?.status).toBe("done");

    const events = await listRunEvents(runtime.db, first.run.id);
    const result = events.find(
      (e) =>
        e.type === "tool_result" && JSON.stringify(e.payload).includes("Created and delivered"),
    );
    expect(JSON.stringify(result?.payload)).toContain("1 page");
    expect(JSON.stringify(result?.payload)).toContain("all embedded");

    const messages = await listMessages(runtime.db, first.message.conversationId, { limit: 10 });
    const answer = messages.find((m) => m.authorKind === "bot");
    expect(answer?.text).toBe("Pronto.");
    expect(answer?.attachments).toEqual([
      {
        id: expect.any(String),
        name: "historia-biblioteca.pdf",
        mime: "application/pdf",
        size: expect.any(Number),
      },
    ]);
    expect(answer?.attachments).toHaveLength(1);
    const stored = await getFile(runtime.db, answer?.attachments?.[0]?.id ?? "");
    const bytes = Buffer.from(stored?.content ?? []);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(stored?.botId).toBe(bot.id);
    // The author stored in the file is the bot's name.
    expect(bytes.toString("latin1")).toContain("Redatora");
    await runtime.close();
  });

  it("a document that fails its check delivers nothing and the bot is told why", async () => {
    const runtime = await open({
      agent: [
        {
          calls: [call("create_document", { format: "pdf", name: "x.pdf", content: "# \n\nTODO" })],
        },
        { text: "Vou corrigir." },
      ],
    });
    const bot = await createBot(runtime.db, {
      name: "Redatora",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["shell"],
    });
    const first = await sendMessage(runtime, { botId: bot.id, text: "Faça" });
    await work(runtime, first.run.id);
    const events = await listRunEvents(runtime.db, first.run.id);
    expect(JSON.stringify(events.filter((e) => e.type === "tool_result"))).toContain(
      "was not delivered",
    );
    const messages = await listMessages(runtime.db, first.message.conversationId, { limit: 10 });
    const answer = messages.find((m) => m.authorKind === "bot");
    expect(answer?.attachments ?? []).toEqual([]);
    await runtime.close();
  });
});
