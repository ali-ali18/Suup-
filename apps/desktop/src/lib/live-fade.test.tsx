import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FadeSink } from "./live-fade.js";
import { Markdown } from "./markdown.js";

describe("o texto ao vivo esmaece", () => {
  it("separa o pedaço novo do que já estava, contando só o texto desenhado", () => {
    const sink = new FadeSink([
      { id: 1, start: 0, at: 0 },
      { id: 2, start: 5, at: 0 },
    ]);
    expect(sink.wrap("abcdefgh")).toEqual([
      { id: "f1-0", text: "abcde" },
      { id: "f2-1", text: "fgh" },
    ]);
    expect(sink.total).toBe(8);
  });

  it("sem esmaecer o markdown não ganha elemento nenhum", () => {
    const { container } = render(<Markdown text="oi **você**" />);
    expect(container.querySelector(".ui-live-in")).toBeNull();
  });

  it("com esmaecer o texto fica igual e o pedaço novo tem o próprio elemento", () => {
    const fade = new FadeSink([{ id: 1, start: 3, at: 0 }]);
    const { container } = render(<Markdown text="oi **você**" fade={fade} />);
    expect(container.textContent).toBe("oi você");
    expect(container.querySelectorAll(".ui-live-in").length).toBeGreaterThan(0);
  });
});
