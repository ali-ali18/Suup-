import { describe, expect, it } from "vitest";
import { createSseParser, type SseFrame } from "../src/index.js";

const parse = (chunks: string[]) => {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = createSseParser({
    onFrame: (f) => frames.push(f),
    onComment: (c) => comments.push(c),
    onRetry: (ms) => retries.push(ms),
  });
  for (const chunk of chunks) parser.push(chunk);
  return { frames, comments, retries };
};

describe("SSE parser", () => {
  it("reads id, event and data", () => {
    const { frames } = parse(['id: 12\nevent: run.event\ndata: {"a":1}\n\n']);
    expect(frames).toEqual([{ id: "12", event: "run.event", data: '{"a":1}' }]);
  });

  it("is the same whatever the pieces the network delivers (split anywhere, even in a field name)", () => {
    const text = "id: 1\nevent: a\ndata: x\n\nid: 2\nevent: b\ndata: y\n\n";
    const whole = parse([text]).frames;
    for (let cut = 1; cut < text.length; cut++) {
      expect(parse([text.slice(0, cut), text.slice(cut)]).frames).toEqual(whole);
    }
    expect(parse([...text].map((c) => c)).frames).toEqual(whole);
    expect(whole.map((f) => f.event)).toEqual(["a", "b"]);
  });

  it("accepts LF, CRLF and CR line endings, including a CRLF split between chunks", () => {
    const expected = [{ event: "e", data: "d", id: "7" }];
    expect(parse(["id: 7\nevent: e\ndata: d\n\n"]).frames).toEqual(expected);
    expect(parse(["id: 7\r\nevent: e\r\ndata: d\r\n\r\n"]).frames).toEqual(expected);
    expect(parse(["id: 7\revent: e\rdata: d\r\r"]).frames).toEqual(expected);
    expect(parse(["id: 7\r", "\nevent: e\r", "\ndata: d\r", "\n\r", "\n"]).frames).toEqual(
      expected,
    );
  });

  it("joins several data lines with a newline, and defaults the event name to message", () => {
    const { frames } = parse(["data: a\ndata: b\ndata:\ndata: c\n\n"]);
    expect(frames).toEqual([{ event: "message", data: "a\nb\n\nc" }]);
  });

  it("strips one leading space of the value, no more; a field with no colon has an empty value", () => {
    expect(parse(["data:  two spaces\n\n"]).frames[0]?.data).toBe(" two spaces");
    expect(parse(["data:nospace\n\n"]).frames[0]?.data).toBe("nospace");
    expect(parse(["data\n\n"]).frames[0]?.data).toBe("");
  });

  it("reports comments (the server's keep-alive) without making a frame of them", () => {
    const { frames, comments } = parse([": ping\n\n:\n\nevent: x\ndata: 1\n\n"]);
    expect(comments).toEqual(["ping", ""]);
    expect(frames).toEqual([{ event: "x", data: "1" }]);
  });

  it("dispatches nothing for a frame with no data (a retry hint or a bare id only adjusts the connection)", () => {
    const { frames, retries } = parse(["retry: 3000\n\nid: 9\n\nevent: x\n\n"]);
    expect(frames).toEqual([]);
    expect(retries).toEqual([3000]);
    expect(parse(["retry: soon\n\n"]).retries).toEqual([]);
  });

  it("keeps an incomplete frame until its blank line arrives, and ignores unknown fields", () => {
    const parser: string[] = [];
    const p = createSseParser({ onFrame: (f) => parser.push(f.data) });
    p.push("data: half");
    expect(parser).toEqual([]);
    p.push("\nfoo: bar\n\n");
    expect(parser).toEqual(["half"]);
  });

  it("ignores an id with a NUL (the standard says so) and reset() forgets a partial frame", () => {
    expect(parse(["id: a\u0000b\ndata: x\n\n"]).frames).toEqual([{ event: "message", data: "x" }]);
    const frames: SseFrame[] = [];
    const p = createSseParser({ onFrame: (f) => frames.push(f) });
    p.push("event: lost\ndata: partial");
    p.reset();
    p.push("data: fresh\n\n");
    expect(frames).toEqual([{ event: "message", data: "fresh" }]);
  });
});
