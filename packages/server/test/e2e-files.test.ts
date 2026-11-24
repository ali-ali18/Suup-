import { ApiError } from "@suup/api";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// The bot hands a file to the chat (`send_file`) end to end: the real client over HTTP, the worker
// in another runtime, the local sandbox. The message carries the file, `GET /v1/files/:id` downloads
// it, always as an attachment and behind the token.

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
// A plain text file: a PDF would be opened and checked before delivery (send_file), and this test
// is about the card and the download, not about the check.
const PDF_TEXT = "História da biblioteca da cidade\n";

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-FILE",
        agent: [
          s({
            calls: [
              {
                name: "write_file",
                args: { path: "pesquisa/historia_biblioteca.txt", content: PDF_TEXT },
              },
            ],
          }),
          s({
            calls: [
              {
                name: "send_file",
                args: {
                  path: "pesquisa/historia_biblioteca.txt",
                  name: "História da biblioteca da cidade.txt",
                },
              },
            ],
          }),
          s({ text: "Pronto: o PDF da história está aqui embaixo." }),
        ],
      },
    ],
  },
  outro: { cases: [] },
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("the server, end to end: files in the chat"), () => {
  const w = useWorld({ scripts: SCRIPTS });

  it("the bot's message carries the file (REST and stream), and it downloads as an attachment", async () => {
    const { api, url } = w.started;
    const bot = await api.bots.create({
      name: "Pesquisa",
      modelId: "model-x",
      allowedTools: ["write_file"],
    });
    const conversation = await api.bots.openConversation(bot.id);
    const f = follow(api);
    await f.waitFor((e) => e.type === "ready", "ready");
    const first = await api.conversations.send(conversation.id, "CASE-FILE faça o PDF");
    const streamed = await f.waitFor(
      (e) =>
        e.type === "message.created" &&
        e.data.message.authorKind === "bot" &&
        e.data.message.runId === first.run.id,
      "the bot's answer",
    );
    const attachment = {
      id: expect.any(String),
      name: "História da biblioteca da cidade.txt",
      mime: "text/plain",
      size: Buffer.byteLength(PDF_TEXT),
      kind: "text",
    };
    expect(
      streamed.event.type === "message.created" && streamed.event.data.message.attachments,
    ).toEqual([attachment]);
    const page = await until(async () => {
      const p = await api.conversations.messages(conversation.id, { limit: 50 });
      return p.items.some((m) => m.attachments !== undefined) ? p : undefined;
    }, "the message with the file");
    const answer = page.items.find((m) => m.attachments !== undefined);
    expect(answer?.text).toBe("Pronto: o PDF da história está aqui embaixo.");
    expect(answer?.attachments).toEqual([attachment]);
    const fileId = answer?.attachments?.[0]?.id as string;

    // The exact bytes through the client.
    const bytes = await api.files.download(fileId);
    expect(Buffer.from(bytes).toString("utf8")).toBe(PDF_TEXT);
    expect(api.files.url(fileId)).toBe(`${url}/v1/files/${fileId}`);

    // The headers: a download, never shown inline, never run on this origin.
    const raw = await fetch(`${url}/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${w.token}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/plain");
    expect(raw.headers.get("content-length")).toBe(String(Buffer.byteLength(PDF_TEXT)));
    expect(raw.headers.get("content-disposition")).toBe(
      `attachment; filename="Hist_ria da biblioteca da cidade.txt"; filename*=UTF-8''Hist%C3%B3ria%20da%20biblioteca%20da%20cidade.txt`,
    );
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await raw.arrayBuffer()).toString("utf8")).toBe(PDF_TEXT);
    f.close();
  });

  it("behind the token; an unknown id or one that is not a uuid is not found", async () => {
    const { api, url } = w.started;
    expect((await fetch(`${url}/v1/files/00000000-0000-4000-8000-000000000000`)).status).toBe(401);
    for (const fileId of ["00000000-0000-4000-8000-000000000000", "nao-e-um-id"]) {
      const error = await api.files.download(fileId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("not_found");
    }
  });
});
