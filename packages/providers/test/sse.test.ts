import { ProviderError } from "@suup/core";
import { describe, expect, it } from "vitest";
import { parseSse, type SseMessage } from "../src/sse.js";
import { splitEvery, streamOf } from "./helpers.js";

async function parse(chunks: (string | Uint8Array)[], then: "end" | "error" = "end") {
  const out: SseMessage[] = [];
  for await (const message of parseSse(streamOf(chunks, then))) out.push(message);
  return out;
}

const wire = 'event: a\ndata: one\n\ndata: two\ndata: lines\n\n: comment\ndata: {"x":1}\n\n';
const expected: SseMessage[] = [
  { event: "a", data: "one" },
  { event: undefined, data: "two\nlines" },
  { event: undefined, data: '{"x":1}' },
];

describe("parseSse", () => {
  it("parses LF, CRLF and CR streams", async () => {
    expect(await parse([wire])).toEqual(expected);
    expect(await parse([wire.replaceAll("\n", "\r\n")])).toEqual(expected);
    expect(await parse([wire.replaceAll("\n", "\r")])).toEqual(expected);
  });

  it("is independent of chunk boundaries, even between CR and LF", async () => {
    const crlf = wire.replaceAll("\n", "\r\n");
    for (const size of [1, 2, 3, 5, 7]) {
      expect(await parse(splitEvery(wire, size))).toEqual(expected);
      expect(await parse(splitEvery(crlf, size))).toEqual(expected);
    }
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"olá — 日本"}\n\n');
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await parse(chunks)).toEqual([{ event: undefined, data: '{"t":"olá — 日本"}' }]);
  });

  it("ignores a BOM, accepts fields without a space and without value", async () => {
    expect(await parse(["﻿data:a\n\ndata\n\ndata: b\n\n"])).toEqual([
      { event: undefined, data: "a" },
      { event: undefined, data: "" },
      { event: undefined, data: "b" },
    ]);
  });

  it("dispatches a final event that lacks the blank line", async () => {
    expect(await parse(["data: [DONE]"])).toEqual([{ event: undefined, data: "[DONE]" }]);
    expect(await parse(["data: x\r"])).toEqual([{ event: undefined, data: "x" }]);
  });

  it("turns a read failure into a network ProviderError", async () => {
    const attempt = parse(["data: a\n\n"], "error");
    await expect(attempt).rejects.toBeInstanceOf(ProviderError);
    await expect(attempt).rejects.toMatchObject({ kind: "network" });
  });
});
