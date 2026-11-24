import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DOCUMENT_MIME,
  type DocumentMaker,
  type DocumentRequest,
  type FileSender,
  MAX_SENT_FILE_BYTES,
  type MakeResult,
  type OutgoingFile,
  type ToolContext,
  ToolRegistry,
} from "@suup/core";
import { describe, expect, it } from "vitest";
import { createDocumentTool } from "../src/index.js";
import { localWorkspace } from "./local-helpers.js";

const registry = new ToolRegistry();
registry.register(createDocumentTool);

/** Stores by call id like the runtime does: the same call again gives the same file. */
function sender() {
  const sent = new Map<string, { file: OutgoingFile; id: string }>();
  const seam: FileSender = {
    async send(file, callId) {
      const known = sent.get(callId);
      if (known !== undefined) return { id: known.id };
      const id = `file-${sent.size + 1}`;
      sent.set(callId, { file, id });
      return { id };
    },
  };
  return { seam, sent };
}

function fakeMaker(result: (r: DocumentRequest) => MakeResult, paths: string[] = []) {
  const requests: DocumentRequest[] = [];
  const seen: ReadonlyMap<string, Uint8Array>[] = [];
  const maker: DocumentMaker = {
    imagePaths: () => paths,
    async make(request, images) {
      requests.push(request);
      seen.push(images);
      return result(request);
    },
  };
  return { maker, requests, seen };
}

const okResult = (bytes = new Uint8Array([1, 2, 3, 4]), mime = DOCUMENT_MIME.pdf): MakeResult => ({
  ok: true,
  document: { bytes, mime, title: "T", pages: 2, notes: [], checks: ["2 pages", "fonts embedded"] },
});

async function setup(
  maker: DocumentMaker,
  files: Record<string, Uint8Array> = {},
  callId = "call-9",
) {
  const executor = await localWorkspace();
  for (const [path, content] of Object.entries(files)) {
    const real = join(executor.root, path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content);
  }
  const { seam, sent } = sender();
  const ctx: ToolContext = {
    runId: "run-1",
    botId: "bot-1",
    executor,
    signal: new AbortController().signal,
    now: () => new Date(),
    files: seam,
    documents: maker,
    callId,
  };
  return { executor, ctx, sent };
}

describe("create_document", () => {
  it("tells the bot to use it instead of the terminal, and that the card shows the name", () => {
    const d = createDocumentTool.description;
    expect(d).toContain("Do NOT build these files with the terminal, Python");
    expect(d).toContain("never repeat its name in your text");
    expect(createDocumentTool.risk).toBe("read");
  });

  it("builds, delivers through the file seam with the call id, and reports the checks", async () => {
    const { maker, requests } = fakeMaker(() => okResult());
    const { ctx, sent } = await setup(maker);
    const r = await registry.invoke(
      "create_document",
      { format: "pdf", name: "historia", content: "# História", style: "academico", maxPages: 5 },
      ctx,
    );
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain('"historia.pdf"');
    expect(r.output.content).toContain("2 pages, file file-1");
    expect(r.output.content).toContain("Checked: 2 pages; fonts embedded");
    expect(r.output.content).toContain("do not repeat its name");
    expect(requests[0]).toMatchObject({
      format: "pdf",
      name: "historia.pdf",
      style: "academico",
      maxPages: 5,
      markdown: "# História",
    });
    const stored = sent.get("call-9");
    expect(stored?.file).toMatchObject({ name: "historia.pdf", mime: "application/pdf" });
    expect([...(stored?.file.bytes ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent per call: running the same call twice stores one file", async () => {
    const { maker } = fakeMaker(() => okResult());
    const { ctx, sent } = await setup(maker);
    const input = { format: "pdf", name: "a.pdf", content: "# A" };
    await registry.invoke("create_document", input, ctx);
    await registry.invoke("create_document", input, ctx);
    expect(sent.size).toBe(1);
  });

  it("an xlsx takes sheets, and the wrong kind of content is explained", async () => {
    const { maker, requests } = fakeMaker(() => okResult(new Uint8Array([9]), DOCUMENT_MIME.xlsx));
    const { ctx, sent } = await setup(maker);
    const bad = await registry.invoke(
      "create_document",
      { format: "xlsx", name: "p", content: "texto" },
      ctx,
    );
    expect(bad.output.isError).toBe(true);
    expect(bad.output.content).toContain("array of sheets");
    const bad2 = await registry.invoke(
      "create_document",
      { format: "docx", name: "p", content: [{ rows: [["a"]] }] },
      ctx,
    );
    expect(bad2.output.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const ok = await registry.invoke(
      "create_document",
      { format: "xlsx", name: "Vendas.XLSX", content: [{ rows: [["a"], [1]] }] },
      ctx,
    );
    expect(ok.outcome).toBe("ok");
    expect(requests[0]).toMatchObject({ format: "xlsx", name: "Vendas.XLSX" });
    expect([...sent.keys()]).toEqual(["call-9"]);
  });

  it("when verification fails the bot gets the problems and nothing is delivered", async () => {
    const { maker } = fakeMaker(() => ({
      ok: false,
      problems: ["The PDF has 9 pages but at most 3 were asked for."],
    }));
    const { ctx, sent } = await setup(maker);
    const r = await registry.invoke(
      "create_document",
      { format: "pdf", name: "a.pdf", content: "# A", maxPages: 3 },
      ctx,
    );
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("was not delivered");
    expect(r.output.content).toContain("9 pages but at most 3");
    expect(sent.size).toBe(0);
  });

  it("reads images from the workspace only, through the checked read", async () => {
    const { maker, seen } = fakeMaker(() => okResult(), ["fig/a.png"]);
    const png = new Uint8Array([0x89, 0x50]);
    const { executor, ctx, sent } = await setup(maker, { "fig/a.png": png });
    const r = await registry.invoke(
      "create_document",
      { format: "pdf", name: "a.pdf", content: "![x](fig/a.png)" },
      ctx,
    );
    expect(r.outcome).toBe("ok");
    expect([...(seen[0]?.get("fig/a.png") ?? [])]).toEqual([0x89, 0x50]);

    const outside = join(dirname(executor.root), "fora.png");
    await writeFile(outside, png);
    await symlink(outside, join(executor.root, "atalho.png"));
    for (const path of ["../fora.png", outside, "atalho.png"]) {
      const escaping = fakeMaker(() => okResult(), [path]);
      const c2 = { ...ctx, documents: escaping.maker, callId: `c-${path}` };
      const res = await registry.invoke(
        "create_document",
        { format: "pdf", name: "b.pdf", content: `![x](${path})` },
        c2,
      );
      expect(res.output.isError, path).toBe(true);
      expect(res.output.content, path).toContain("outside your workspace");
    }
    expect(sent.size).toBe(1);
  });

  it("refuses a file over 25 MB", async () => {
    const { maker } = fakeMaker(() => okResult(new Uint8Array(MAX_SENT_FILE_BYTES + 1)));
    const { ctx, sent } = await setup(maker);
    const r = await registry.invoke(
      "create_document",
      { format: "pdf", name: "a.pdf", content: "# A" },
      ctx,
    );
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("25 MB");
    expect(sent.size).toBe(0);
  });

  it("an input over the size limits is refused before anything is built", async () => {
    const { maker, requests } = fakeMaker(() => okResult());
    const { ctx, sent } = await setup(maker);
    const r = await registry.invoke(
      "create_document",
      { format: "xlsx", name: "a", content: [{ rows: [["a"], ["x".repeat(40_000)]] }] },
      ctx,
    );
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("32767 characters");
    expect(requests).toHaveLength(0);
    expect(sent.size).toBe(0);
  });

  it("without a chat or a maker it says so", async () => {
    const { maker } = fakeMaker(() => okResult());
    const { ctx } = await setup(maker);
    const { files: _f, ...noChat } = ctx;
    const r = await registry.invoke(
      "create_document",
      { format: "pdf", name: "a.pdf", content: "# A" },
      noChat,
    );
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("cannot be delivered");
  });
});
