import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  detectFileType,
  type FileSender,
  MAX_SENT_FILE_BYTES,
  type OutgoingFile,
  type ToolContext,
  ToolRegistry,
} from "@suup/core";
import { describe, expect, it } from "vitest";
import { sendFileTool } from "../src/index.js";
import { localWorkspace } from "./local-helpers.js";

const registry = new ToolRegistry();
registry.register(sendFileTool);

function sender(): FileSender & { sent: { file: OutgoingFile; callId: string }[] } {
  const sent: { file: OutgoingFile; callId: string }[] = [];
  return {
    sent,
    async send(file, callId) {
      sent.push({ file, callId });
      return { id: `file-${sent.length}` };
    },
  };
}

async function setup(files: Record<string, Uint8Array | string> = {}) {
  const executor = await localWorkspace();
  for (const [path, content] of Object.entries(files)) {
    const real = join(executor.root, path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content);
  }
  const files_ = sender();
  const ctx: ToolContext = {
    runId: "run-1",
    botId: "bot-1",
    executor,
    signal: new AbortController().signal,
    now: () => new Date(),
    files: files_,
    callId: "call-7",
  };
  return { executor, ctx, sent: files_.sent };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff]);

describe("send_file", () => {
  it("tells the bot the file is a card under its message, so it never repeats the name or path", () => {
    expect(sendFileTool.description).toContain("It appears as a card under your message");
    expect(sendFileTool.description).toContain("never repeat its name or path in your text");
  });

  it("is a read: it reaches only the user's own chat", () => {
    expect(sendFileTool.risk).toBe("read");
    expect(sendFileTool.outbound).toBeUndefined();
  });

  it("hands the exact bytes, the file's name and the type from its signature to the chat", async () => {
    const { ctx, sent } = await setup({ "pesquisa/historia.pdf": PDF });
    const r = await registry.invoke("send_file", { path: "pesquisa/historia.pdf" }, ctx);
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain('Sent "historia.pdf"');
    expect(r.output.content).toContain("do not repeat its name or path");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.callId).toBe("call-7");
    expect(sent[0]?.file.name).toBe("historia.pdf");
    expect(sent[0]?.file.mime).toBe("application/pdf");
    expect([...(sent[0]?.file.bytes ?? [])]).toEqual([...PDF]);
  });

  it("takes the name the bot gives, and the type follows the bytes, not the name", async () => {
    const { ctx, sent } = await setup({ "out.bin": PDF });
    await registry.invoke("send_file", { path: "out.bin", name: "Relatório final.pdf" }, ctx);
    expect(sent[0]?.file).toMatchObject({ name: "Relatório final.pdf", mime: "application/pdf" });
  });

  it("refuses a missing file, a directory and an empty name, with what to do", async () => {
    const { ctx, sent } = await setup({ "pasta/a.txt": "a" });
    const missing = await registry.invoke("send_file", { path: "nada.pdf" }, ctx);
    expect(missing.output.isError).toBe(true);
    expect(missing.output.content).toContain("does not exist");
    const dir = await registry.invoke("send_file", { path: "pasta" }, ctx);
    expect(dir.output.content).toContain("zip");
    const nameless = await registry.invoke("send_file", { path: "pasta/a.txt", name: "/" }, ctx);
    expect(nameless.output.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("refuses a path outside the workspace, also through a symlink, and says to copy it in", async () => {
    const { executor, ctx, sent } = await setup();
    const outside = join(dirname(executor.root), "fora.pdf");
    await writeFile(outside, PDF);
    await symlink(outside, join(executor.root, "atalho.pdf"));
    for (const path of ["../fora.pdf", outside, "atalho.pdf"]) {
      const r = await registry.invoke("send_file", { path }, ctx);
      expect(r.output.isError, path).toBe(true);
      expect(r.output.content, path).toContain("outside your workspace");
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a file over 25 MB before reading it", async () => {
    const { ctx, sent } = await setup({ "grande.bin": new Uint8Array(MAX_SENT_FILE_BYTES + 1) });
    const r = await registry.invoke("send_file", { path: "grande.bin" }, ctx);
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("25 MB");
    expect(sent).toHaveLength(0);
  });

  it("without a chat to deliver to, it says so", async () => {
    const { ctx } = await setup({ "a.pdf": PDF });
    const { files: _none, ...bare } = ctx;
    const r = await registry.invoke("send_file", { path: "a.pdf" }, bare);
    expect(r.output.isError).toBe(true);
    expect(r.output.content).toContain("cannot be sent");
  });
});

describe("detectFileType: signature first, then the extension, exact tables", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it("reads the type from the first bytes", () => {
    expect(detectFileType(PDF, "x")).toEqual({ mime: "application/pdf", kind: "pdf" });
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "a.txt")).toEqual({
      mime: "image/png",
      kind: "image",
    });
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0), "foto")).toMatchObject({
      mime: "image/jpeg",
    });
  });
  it("a ZIP named as an Office file is that file; a plain ZIP is an archive", () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14);
    expect(detectFileType(zip, "planilha.xlsx").kind).toBe("spreadsheet");
    expect(detectFileType(zip, "doc.docx").kind).toBe("document");
    expect(detectFileType(zip, "slides.PPTX").kind).toBe("presentation");
    expect(detectFileType(zip, "coisas.zip")).toEqual({ mime: "application/zip", kind: "archive" });
    expect(detectFileType(zip, "sem-extensao").kind).toBe("archive");
  });
  it("without a signature the extension decides; with neither, it is plain bytes", () => {
    expect(detectFileType(bytes(0x6f, 0x69), "notas.md")).toEqual({
      mime: "text/markdown",
      kind: "text",
    });
    expect(detectFileType(bytes(0x61, 0x2c, 0x62), "dados.csv").kind).toBe("spreadsheet");
    expect(detectFileType(bytes(0x00, 0x01), "x.qqq")).toEqual({
      mime: "application/octet-stream",
      kind: "other",
    });
  });
});
