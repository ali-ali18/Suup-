import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileSender, type OutgoingFile, type ToolContext, ToolRegistry } from "@suup/core";
import { LocalExecutor } from "@suup/sandbox";
import { sendFileTool } from "@suup/tools";
import { afterAll, describe, expect, it } from "vitest";
import { createDocumentMaker } from "../src/index.js";

// `send_file` with the real checker: what the bot's own code makes is opened again before delivery.

const registry = new ToolRegistry();
registry.register(sendFileTool);
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A one-page PDF written by hand with a font that is NOT embedded (Helvetica, one of the 14). */
function pdfWithoutEmbeddedFont(): Uint8Array {
  const text = "BT /F1 12 Tf 72 700 Td (Ola mundo) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

async function setup(files: Record<string, Uint8Array>) {
  const dir = await mkdtemp(join(tmpdir(), "suup-sendcheck-"));
  dirs.push(dir);
  const root = join(dir, "workspace");
  await mkdir(root, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  const executor = new LocalExecutor({ root, iUnderstandThisIsNotIsolated: true });
  const sent: OutgoingFile[] = [];
  const files_: FileSender = {
    async send(file) {
      sent.push(file);
      return { id: `file-${sent.length}` };
    },
  };
  const ctx: ToolContext = {
    runId: "r",
    botId: "b",
    executor,
    signal: new AbortController().signal,
    now: () => new Date(),
    files: files_,
    documents: createDocumentMaker({ author: "Bot" }),
    callId: "c1",
  };
  return { ctx, sent };
}

describe("send_file with the real checker", () => {
  it("refuses a PDF whose font is not embedded, and force delivers it with the reason", async () => {
    const { ctx, sent } = await setup({ "r.pdf": pdfWithoutEmbeddedFont() });
    const refused = await registry.invoke("send_file", { path: "r.pdf" }, ctx);
    expect(refused.output.isError).toBe(true);
    expect(refused.output.content).toContain("The font is not embedded in the PDF");
    expect(sent).toHaveLength(0);

    const forced = await registry.invoke(
      "send_file",
      { path: "r.pdf", force: true, reason: "pedido do usuário" },
      ctx,
    );
    expect(forced.outcome).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(forced.output.content).toContain("Delivered with force");
  });

  it("delivers a file made by create_document's maker and reports the measured facts", async () => {
    const maker = createDocumentMaker({ author: "Bot" });
    const made = await maker.make(
      {
        format: "pdf",
        name: "ok.pdf",
        style: "padrao",
        markdown: "# Relatório\n\nTexto com acentuação.",
      },
      new Map(),
    );
    if (!made.ok) throw new Error(made.problems.join("; "));
    const { ctx, sent } = await setup({ "ok.pdf": made.document.bytes });
    const r = await registry.invoke("send_file", { path: "ok.pdf" }, ctx);
    expect(r.outcome).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(r.output.content).toContain("Measured: PDF, 1 page, 210 x 297 mm (A4)");
  });
});
